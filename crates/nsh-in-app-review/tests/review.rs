//! `request_review` through the fakes: the hand-over answer, one flow at a time, cancellation,
//! platforms with nothing to ask, and the exactly-once rule.

use std::{
    future::{Future, ready},
    sync::Arc,
};

use nsh_in_app_review::{
    Backend, BackendFuture, ErrorKind, FakeBackend, FakeOpener, InAppReview, InAppReviewError,
    MemoryQuotaTracker, ReviewDone, StoreListingOptions,
};

/// Runs `future` on a LocalSet: the backend's futures borrow their backend and are not `Send`,
/// so a call that waits for its prompt runs as a local task.
fn run<F: Future>(future: F) -> F::Output {
    let local = tokio::task::LocalSet::new();
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(local.run_until(future))
}

/// Yields until `ready` holds, so a spawned call has reached its prompt.
async fn settle(ready: impl Fn() -> bool) {
    for _ in 0..1000 {
        if ready() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the prompt never started");
}

/// Starts a review on its own local task, and waits until its prompt is up.
async fn started(
    review: &InAppReview,
    fake: &FakeBackend,
) -> tokio::task::JoinHandle<Result<bool, InAppReviewError>> {
    let call = review.clone();
    let handle = tokio::task::spawn_local(async move { call.request_review().await });
    settle(|| fake.prompt_pending()).await;
    handle
}

/// An Apple-shaped backend: StoreKit has no callback, so the flow ends with the hand-over itself.
struct HandOverBackend;

impl Backend for HandOverBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(Ok::<bool, InAppReviewError>(true)))
    }

    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError> {
        done(Ok(true));
        Ok(())
    }

    fn store_listing_url(
        &self,
        _options: &StoreListingOptions,
    ) -> Result<String, InAppReviewError> {
        Ok("https://example.com/store-listing".to_owned())
    }
}

/// A target with no review flow and no store, the shape of the crate's own unsupported and Linux
/// backends: every call says so with `Err(NotAvailable)`.
struct NoStoreBackend;

impl Backend for NoStoreBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(Ok::<bool, InAppReviewError>(false)))
    }

    fn start_review(&self, _done: ReviewDone) -> Result<(), InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }

    fn store_listing_url(
        &self,
        _options: &StoreListingOptions,
    ) -> Result<String, InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }
}

#[test]
fn request_review_has_no_signal_that_the_prompt_showed() {
    let handed = InAppReview::new(Arc::new(HandOverBackend), Arc::new(FakeOpener::new()));
    let fake = FakeBackend::new();
    let waited = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        // The answer fires at hand-over, before anything could show: the `true` is all the API
        // says, and it says nothing about a prompt appearing.
        assert_eq!(handed.request_review().await, Ok(true));
        assert_eq!(handed.is_available().await, Ok(true));

        // A flow the system answers ends in the same `true`: no "shown" bit exists anywhere.
        let call = started(&waited, &fake).await;
        fake.finish_prompt(Ok(true));
        assert_eq!(call.await.unwrap(), Ok(true));
    });
}

#[test]
fn second_request_while_a_flow_is_open_is_in_progress() {
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        let first = started(&review, &fake).await;
        let second = review.request_review().await.unwrap_err();
        assert_eq!(second.kind(), ErrorKind::InProgress);
        assert_eq!(second.code(), "ERR_IN_APP_REVIEW_IN_PROGRESS");
        assert_eq!(fake.prompts_started(), 1);
        fake.finish_prompt(Ok(true));
        assert_eq!(first.await.unwrap(), Ok(true));
    });
}

#[test]
fn cancelled_flow_resolves_once_with_cancelled() {
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        let call = started(&review, &fake).await;
        assert!(fake.finish_prompt(Err(InAppReviewError::new(ErrorKind::Cancelled))));
        let error = call.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Cancelled);
        assert_eq!(error.code(), "ERR_IN_APP_REVIEW_CANCELLED");
        // The flow answered once; a second answer has no call left to resolve.
        assert!(!fake.finish_prompt(Err(InAppReviewError::new(ErrorKind::Cancelled))));

        let next = started(&review, &fake).await;
        fake.finish_prompt(Ok(true));
        assert_eq!(next.await.unwrap(), Ok(true));
    });
}

#[test]
fn unsupported_platforms_report_not_available() {
    let opener = FakeOpener::new();
    let review = InAppReview::new(Arc::new(NoStoreBackend), Arc::new(opener.clone()));
    run(async move {
        assert_eq!(review.is_available().await, Ok(false));
        let refused = review.request_review().await.unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::NotAvailable);
        assert_eq!(refused.code(), "ERR_IN_APP_REVIEW_NOT_AVAILABLE");
        let listing = review
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(listing.kind(), ErrorKind::NotAvailable);
        assert_eq!(opener.last_opened(), None);

        // A platform whose flow exists but answers unavailable says the same, with no prompt.
        let fake = FakeBackend::new();
        fake.set_available(Ok(false));
        let unavailable = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
        let error = unavailable.request_review().await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotAvailable);
        assert_eq!(fake.prompts_started(), 0);
    });
}

#[test]
fn every_call_resolves_exactly_once() {
    let fake = FakeBackend::new();
    let review = InAppReview::with_quota(
        Arc::new(fake.clone()),
        Arc::new(FakeOpener::new()),
        Arc::new(MemoryQuotaTracker::new()),
    );
    run(async {
        // A success: one answer resolves the call once; a second answer has nothing to resolve.
        let first = started(&review, &fake).await;
        let refused = review.request_review().await.unwrap_err();
        assert_eq!(refused.code(), "ERR_IN_APP_REVIEW_IN_PROGRESS");
        assert!(fake.finish_prompt(Ok(true)));
        assert_eq!(first.await.unwrap(), Ok(true));
        assert!(!fake.finish_prompt(Ok(false)));

        // A coded error: resolved once, and the gate frees for the next call.
        let failed = started(&review, &fake).await;
        assert!(fake.finish_prompt(Err(InAppReviewError::new(ErrorKind::Backend))));
        assert_eq!(
            failed.await.unwrap().unwrap_err().code(),
            "ERR_IN_APP_REVIEW_BACKEND"
        );

        // A cancel: resolved once with its code.
        let cancelled = started(&review, &fake).await;
        assert!(fake.finish_prompt(Err(InAppReviewError::new(ErrorKind::Cancelled))));
        assert_eq!(
            cancelled.await.unwrap().unwrap_err().code(),
            "ERR_IN_APP_REVIEW_CANCELLED"
        );

        // The three flows above spent the quota: the suppressed call resolves once, with `false`.
        assert_eq!(review.request_review().await, Ok(false));
        assert_eq!(fake.prompts_started(), 3);
    });
}

#[test]
fn a_dropped_awaiter_still_settles_and_frees_the_gate() {
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        let call = started(&review, &fake).await;
        // The caller goes away after the hand-over; the system's answer still ends the flow.
        call.abort();
        let _ = call.await;
        assert!(fake.finish_prompt(Ok(true)));

        // The answer freed the gate, so the next call runs instead of waiting forever.
        let next = started(&review, &fake).await;
        assert_eq!(fake.prompts_started(), 2);
        fake.finish_prompt(Ok(true));
        assert_eq!(next.await.unwrap(), Ok(true));
    });
}

#[test]
fn an_availability_error_reaches_the_caller() {
    let fake = FakeBackend::new();
    fake.set_available(Err(InAppReviewError::new(ErrorKind::Backend)));
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        assert_eq!(
            review.is_available().await.unwrap_err().code(),
            "ERR_IN_APP_REVIEW_BACKEND"
        );
        let error = review.request_review().await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Backend);
        assert_eq!(fake.prompts_started(), 0);
    });
}
