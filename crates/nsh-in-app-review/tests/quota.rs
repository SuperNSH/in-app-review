//! The client-side quota: three requests per rolling 365 days, checked before the OS is touched,
//! and spent only by a hand-over that started a flow.

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::SeqCst},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use nsh_in_app_review::{
    Backend, BackendFuture, ErrorKind, FakeBackend, FakeOpener, InAppReview, InAppReviewError,
    MemoryQuotaTracker, QuotaTracker, ReviewDone, StoreListingOptions,
};

/// The window the quota rolls over: 365 days of seconds.
const WINDOW: i64 = 365 * 24 * 3600;

/// Seconds since the unix epoch, as the service counts when it asks the tracker.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

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

/// A fake that counts availability reads, so a test sees whether the OS was asked at all.
struct CountingBackend {
    fake: FakeBackend,
    availability_reads: Arc<AtomicUsize>,
}

impl Backend for CountingBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        let fake = self.fake.clone();
        let reads = Arc::clone(&self.availability_reads);
        Box::pin(async move {
            reads.fetch_add(1, SeqCst);
            fake.is_available().await
        })
    }

    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError> {
        self.fake.start_review(done)
    }

    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError> {
        self.fake.store_listing_url(options)
    }
}

#[test]
fn quota_allows_three_requests_per_365_days() {
    // The tracker itself: three timestamps inside one window fill it, whenever they fall.
    let tracker = MemoryQuotaTracker::new();
    let now = 1_700_000_000;
    for day in 0..3 {
        assert!(tracker.can_request(now + day * 24 * 3600));
        tracker.record(now + day * 24 * 3600);
    }
    assert!(!tracker.can_request(now + 100));

    // And through the service: three flows run, one per request.
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        for _ in 0..3 {
            let call = started(&review, &fake).await;
            fake.finish_prompt(Ok(true));
            assert_eq!(call.await.unwrap(), Ok(true));
        }
        assert_eq!(fake.prompts_started(), 3);
    });
}

#[test]
fn quota_suppresses_the_fourth_request() {
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        for _ in 0..3 {
            let call = started(&review, &fake).await;
            fake.finish_prompt(Ok(true));
            assert_eq!(call.await.unwrap(), Ok(true));
        }
        // The fourth inside the window is suppressed with `Ok(false)`, and the OS is never
        // touched: no flow starts.
        assert_eq!(review.request_review().await, Ok(false));
        assert_eq!(fake.prompts_started(), 3);
    });
}

#[test]
fn quota_frees_a_slot_after_365_days() {
    // The tracker itself: a full window admits again once a record is strictly older than it.
    let tracker = MemoryQuotaTracker::new();
    let now = 1_700_000_000;
    tracker.record(now - 100);
    tracker.record(now - 50);
    tracker.record(now - 10);
    assert!(!tracker.can_request(now));
    let later = (now - 100) + WINDOW + 1;
    assert!(
        tracker.can_request(later),
        "the oldest record left the window"
    );
    tracker.record(later);
    assert!(!tracker.can_request(later + 1));

    // Through the service: records older than the window no longer count against a request.
    let fake = FakeBackend::new();
    let service_quota = Arc::new(MemoryQuotaTracker::new());
    let at = unix_now();
    for _ in 0..3 {
        service_quota.record(at - WINDOW - 1);
    }
    let review = InAppReview::with_quota(
        Arc::new(fake.clone()),
        Arc::new(FakeOpener::new()),
        service_quota,
    );
    run(async {
        let call = started(&review, &fake).await;
        fake.finish_prompt(Ok(true));
        assert_eq!(call.await.unwrap(), Ok(true));
        assert_eq!(fake.prompts_started(), 1);
    });
}

#[test]
fn quota_is_checked_before_any_backend_call() {
    let fake = FakeBackend::new();
    let reads = Arc::new(AtomicUsize::new(0));
    let quota = Arc::new(MemoryQuotaTracker::new());
    let at = unix_now();
    for _ in 0..3 {
        quota.record(at);
    }
    let review = InAppReview::with_quota(
        Arc::new(CountingBackend {
            fake: fake.clone(),
            availability_reads: Arc::clone(&reads),
        }),
        Arc::new(FakeOpener::new()),
        quota,
    );
    run(async {
        assert_eq!(review.request_review().await, Ok(false));
        assert_eq!(
            reads.load(SeqCst),
            0,
            "a suppressed request never awaits availability"
        );
        assert_eq!(fake.prompts_started(), 0);
    });
}

#[test]
fn a_failed_hand_over_consumes_no_quota() {
    let fake = FakeBackend::new();
    let quota = Arc::new(MemoryQuotaTracker::new());
    let at = unix_now();
    quota.record(at - 1000);
    quota.record(at - 500);
    let review = InAppReview::with_quota(
        Arc::new(fake.clone()),
        Arc::new(FakeOpener::new()),
        quota.clone(),
    );
    run(async {
        // The hand-over fails before any flow starts: the call errs, and the attempt leaves no
        // record behind.
        fake.fail_next_prompt(InAppReviewError::new(ErrorKind::Backend));
        let error = review.request_review().await.unwrap_err();
        assert_eq!(error.code(), "ERR_IN_APP_REVIEW_BACKEND");
        assert_eq!(fake.prompts_started(), 0);

        // The two seeded records plus this one fill the window: the failure consumed nothing.
        let call = started(&review, &fake).await;
        fake.finish_prompt(Ok(true));
        assert_eq!(call.await.unwrap(), Ok(true));
        assert_eq!(fake.prompts_started(), 1);
        assert!(!quota.can_request(unix_now()));
    });
}
