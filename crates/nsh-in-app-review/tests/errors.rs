//! The errors: five kinds, five stable codes, the platform status beside them, and each kind
//! reaching the caller through a flow.

use std::{future::Future, sync::Arc};

use nsh_in_app_review::{ErrorKind, FakeBackend, FakeOpener, InAppReview, InAppReviewError};

/// The five codes, as the crate defines them. The TS suite
/// (packages/nsh-in-app-review/tests/errors.test.tsx) spells this same list and asserts its own
/// five codes equal it.
const ALL_KINDS: [(ErrorKind, &str); 5] = [
    (ErrorKind::NotAvailable, "ERR_IN_APP_REVIEW_NOT_AVAILABLE"),
    (ErrorKind::Cancelled, "ERR_IN_APP_REVIEW_CANCELLED"),
    (ErrorKind::InProgress, "ERR_IN_APP_REVIEW_IN_PROGRESS"),
    (ErrorKind::Backend, "ERR_IN_APP_REVIEW_BACKEND"),
    (
        ErrorKind::InvalidArgument,
        "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
    ),
];

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

#[test]
fn every_error_kind_has_a_stable_code() {
    for (kind, code) in ALL_KINDS {
        let error = InAppReviewError::new(kind);
        assert_eq!(error.kind(), kind);
        assert_eq!(error.code(), code);
        assert_eq!(kind.code(), code);
        assert_eq!(kind.to_string(), code, "a kind's Display is its code");
        assert_eq!(error.status(), None);
        assert!(!kind.message().is_empty(), "each kind says what to do");
        assert_eq!(error.to_string(), kind.message());
    }

    // The platform's own status travels beside the kind, without changing the code.
    let error = InAppReviewError::new(ErrorKind::Backend).with_status(-7);
    assert_eq!(error.status(), Some(-7));
    assert_eq!(error.code(), "ERR_IN_APP_REVIEW_BACKEND");
    assert_eq!(error.kind(), ErrorKind::Backend);
}

#[test]
fn every_kind_passes_through_the_flow_with_its_code() {
    for (kind, code) in ALL_KINDS {
        // A fresh service per kind: the quota holds three, and the loop asks five times.
        let fake = FakeBackend::new();
        let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
        run(async {
            let call = started(&review, &fake).await;
            assert!(fake.finish_prompt(Err(InAppReviewError::new(kind))));
            let error = call.await.unwrap().unwrap_err();
            assert_eq!(error.kind(), kind);
            assert_eq!(error.code(), code);
        });
    }
}

#[test]
fn a_platform_status_is_kept_with_its_error() {
    let fake = FakeBackend::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(FakeOpener::new()));
    run(async {
        let call = started(&review, &fake).await;
        fake.finish_prompt(Err(
            InAppReviewError::new(ErrorKind::Backend).with_status(-7)
        ));
        let error = call.await.unwrap().unwrap_err();
        assert_eq!(error.status(), Some(-7));
        assert_eq!(error.code(), "ERR_IN_APP_REVIEW_BACKEND");
    });
}
