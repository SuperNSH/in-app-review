//! A backend and an opener with scripted answers. Tests use them, and so can an app that runs
//! without a store.

use std::{
    future::ready,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use crate::{
    backend::{Backend, BackendFuture, ReviewDone, UrlOpener},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// A backend whose answers the test sets, and whose review flow the test finishes.
///
/// Like the platform flows, the prompt waits for its answer: the test calls `finish_prompt`, as the
/// system would. Clones share one state.
#[derive(Clone)]
pub struct FakeBackend {
    state: Arc<Mutex<FakeState>>,
}

struct FakeState {
    available: Result<bool, InAppReviewError>,
    next_start_error: Option<InAppReviewError>,
    waiting: Option<ReviewDone>,
    prompts: usize,
    last_url: Option<String>,
    listing_url: Result<String, InAppReviewError>,
}

impl Default for FakeBackend {
    /// A device with the review flow, a prompt that waits, and a listing URL.
    fn default() -> Self {
        Self::new()
    }
}

impl FakeBackend {
    /// An available backend whose prompt waits for `finish_prompt`, with the default listing URL.
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeState {
                available: Ok(true),
                next_start_error: None,
                waiting: None,
                prompts: 0,
                last_url: None,
                listing_url: Ok("https://example.com/store-listing".to_owned()),
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets what `is_available` answers.
    pub fn set_available(&self, answer: Result<bool, InAppReviewError>) {
        self.lock().available = answer;
    }

    /// Makes the next flow fail to start with `error`, as a platform does when it cannot show one.
    pub fn fail_next_prompt(&self, error: InAppReviewError) {
        self.lock().next_start_error = Some(error);
    }

    /// Whether a flow is waiting for its answer.
    pub fn prompt_pending(&self) -> bool {
        self.lock().waiting.is_some()
    }

    /// Answers the waiting flow. Returns `false` when none waits.
    pub fn finish_prompt(&self, answer: Result<bool, InAppReviewError>) -> bool {
        let waiting = self.lock().waiting.take();
        match waiting {
            Some(done) => {
                done(answer);
                true
            }
            None => false,
        }
    }

    /// How many flows were started.
    pub fn prompts_started(&self) -> usize {
        self.lock().prompts
    }

    /// The URL of the last successful `store_listing_url`.
    pub fn last_url(&self) -> Option<String> {
        self.lock().last_url.clone()
    }

    /// Sets what `store_listing_url` answers.
    pub fn set_listing_url(&self, answer: Result<String, InAppReviewError>) {
        self.lock().listing_url = answer;
    }
}

impl Backend for FakeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(self.lock().available.clone()))
    }

    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError> {
        let mut state = self.lock();
        if let Some(error) = state.next_start_error.take() {
            return Err(error);
        }
        state.prompts += 1;
        state.waiting = Some(done);
        Ok(())
    }

    fn store_listing_url(
        &self,
        _options: &StoreListingOptions,
    ) -> Result<String, InAppReviewError> {
        let mut state = self.lock();
        let answer = state.listing_url.clone();
        if let Ok(url) = &answer {
            state.last_url = Some(url.clone());
        }
        answer
    }
}

/// An opener whose answers the test sets. It records what it was asked to open.
///
/// Clones share one state.
#[derive(Clone)]
pub struct FakeOpener {
    state: Arc<Mutex<OpenerState>>,
}

struct OpenerState {
    open_result: Result<(), InAppReviewError>,
    next_open_error: Option<InAppReviewError>,
    last_opened: Option<String>,
}

impl Default for FakeOpener {
    /// An opener that opens everything.
    fn default() -> Self {
        Self::new()
    }
}

impl FakeOpener {
    /// An opener that succeeds, until the test says otherwise.
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(OpenerState {
                open_result: Ok(()),
                next_open_error: None,
                last_opened: None,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, OpenerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets what every open answers, until set again.
    pub fn set_open_result(&self, answer: Result<(), InAppReviewError>) {
        self.lock().open_result = answer;
    }

    /// Makes the next open fail with `ERR_IN_APP_REVIEW_BACKEND`.
    pub fn fail_next_open(&self) {
        self.lock().next_open_error = Some(InAppReviewError::new(ErrorKind::Backend));
    }

    /// The URL of the last open.
    pub fn last_opened(&self) -> Option<String> {
        self.lock().last_opened.clone()
    }
}

impl UrlOpener for FakeOpener {
    fn open_url(&self, url: &str) -> BackendFuture<'_, Result<(), InAppReviewError>> {
        let mut state = self.lock();
        state.last_opened = Some(url.to_owned());
        let answer = match state.next_open_error.take() {
            Some(error) => Err(error),
            None => state.open_result.clone(),
        };
        Box::pin(ready(answer))
    }
}
