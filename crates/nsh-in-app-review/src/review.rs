//! `InAppReview`: the calls an app makes, with one flow at a time and a client-side quota.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::oneshot;

use crate::{
    backend::{Backend, ReviewDone, UrlOpener},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
    quota::{MemoryQuotaTracker, QuotaTracker, unix_now},
};

type Answer = Result<bool, InAppReviewError>;

/// The flow gate. `busy` lasts until the platform answers, even after the caller stopped waiting:
/// the system's answer ends a flow, not the caller going away.
#[derive(Default)]
struct Gate {
    busy: bool,
    waiting: Option<oneshot::Sender<Answer>>,
}

struct Shared {
    backend: Arc<dyn Backend>,
    opener: Arc<dyn UrlOpener>,
    quota: Arc<dyn QuotaTracker>,
    gate: Mutex<Gate>,
}

impl Shared {
    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.gate.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Frees the gate for the next flow.
    fn release(&self) {
        let mut gate = self.gate();
        gate.busy = false;
        gate.waiting = None;
    }
}

/// In-app review with the OS's prompt, and the store listing as the fallback.
///
/// Clones share one flow gate and one quota.
#[derive(Clone)]
pub struct InAppReview {
    shared: Arc<Shared>,
}

impl InAppReview {
    /// Review through `backend`, opening listings through `opener`, with the default quota of
    /// three requests per rolling 365 days.
    pub fn new(backend: Arc<dyn Backend>, opener: Arc<dyn UrlOpener>) -> Self {
        Self::with_quota(backend, opener, Arc::new(MemoryQuotaTracker::new()))
    }

    /// Review through `backend` and `opener`, with `quota` deciding how often to ask.
    pub fn with_quota(
        backend: Arc<dyn Backend>,
        opener: Arc<dyn UrlOpener>,
        quota: Arc<dyn QuotaTracker>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                backend,
                opener,
                quota,
                gate: Mutex::new(Gate::default()),
            }),
        }
    }

    /// Whether the OS review flow exists on this device.
    pub async fn is_available(&self) -> Result<bool, InAppReviewError> {
        self.shared.backend.is_available().await
    }

    /// Shows the OS review flow and waits for its answer.
    ///
    /// `Ok(true)` means the flow was handed over and, where the backend has a task to await, it
    /// completed with no error signal — never a claim that the OS showed anything (on Apple the
    /// answer fires at hand-over: StoreKit has no callback), so do not call this from a button the
    /// user expects to do something. `Ok(false)` means the quota refused (at most three requests
    /// per rolling 365 days) and no request was made; the OS counts its own limits besides ours. A
    /// second call while one flow runs is `ERR_IN_APP_REVIEW_IN_PROGRESS`; a flow interrupted
    /// before it completes is `ERR_IN_APP_REVIEW_CANCELLED`. Dropping the future leaves the flow
    /// to finish on its own; the next one waits until it has.
    pub async fn request_review(&self) -> Result<bool, InAppReviewError> {
        if self.shared.gate().busy {
            return Err(InAppReviewError::new(ErrorKind::InProgress));
        }
        // The quota comes first: once it is spent, the OS is not asked at all.
        if !self.shared.quota.can_request(unix_now()) {
            return Ok(false);
        }
        if !self.shared.backend.is_available().await? {
            return Err(InAppReviewError::new(ErrorKind::NotAvailable));
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut gate = self.shared.gate();
            if gate.busy {
                return Err(InAppReviewError::new(ErrorKind::InProgress));
            }
            gate.busy = true;
            gate.waiting = Some(sender);
        }
        // Under the gate, counting and handing over are one step: no other call slips between
        // them, and a hand-over that starts nothing puts its count back.
        let now = unix_now();
        if !self.shared.quota.can_request(now) {
            self.shared.release();
            return Ok(false);
        }
        self.shared.quota.record(now);
        let shared = Arc::clone(&self.shared);
        let done: ReviewDone = Box::new(move |answer| answered(&shared, answer));
        if let Err(error) = self.shared.backend.start_review(done) {
            // The count goes back before the gate frees: while both were apart, a caller could
            // take the gate and be refused by the failed hand-over's still-counted record.
            self.shared.quota.unrecord(now);
            self.shared.release();
            return Err(error);
        }
        match receiver.await {
            Ok(answer) => answer,
            // The backend dropped its answer without calling done; the flow is over either way.
            Err(_) => Err(InAppReviewError::new(ErrorKind::Backend)),
        }
    }

    /// Opens the platform's store listing: the backend builds its URL, the opener opens it.
    pub async fn open_store_listing(
        &self,
        options: &StoreListingOptions,
    ) -> Result<(), InAppReviewError> {
        let url = self.shared.backend.store_listing_url(options)?;
        self.shared.opener.open_url(&url).await
    }
}

/// Hands the platform's answer to the waiting call and frees the gate. A caller that went away
/// gets nothing sent, but its flow still ends here.
fn answered(shared: &Shared, answer: Answer) {
    let sender = {
        let mut gate = shared.gate();
        gate.busy = false;
        gate.waiting.take()
    };
    if let Some(sender) = sender {
        let _ = sender.send(answer);
    }
}
