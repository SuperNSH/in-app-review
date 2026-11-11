//! The seam between [`InAppReview`] and a platform: availability, one review flow, the store URL.

use std::{future::Future, pin::Pin};

use crate::{error::InAppReviewError, options::StoreListingOptions};

/// A future a backend returns. Each call's future borrows the backend.
pub type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Receives the system's answer to one review flow, exactly once: `Ok(true)` completed, `Ok(false)`
/// dismissed without completing.
pub type ReviewDone = Box<dyn FnOnce(Result<bool, InAppReviewError>) + Send>;

/// What a platform provides. [`crate::InAppReview`] adds the rules: one flow at a time, one answer
/// per call, and the client-side quota.
pub trait Backend: Send + Sync {
    /// Whether the OS review flow exists on this device.
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>>;

    /// Hands the flow to the OS and returns at once. An `Err` means no flow started and `done` is
    /// never called. Otherwise `done` is called exactly once, when the system answers — never hung.
    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError>;

    /// Builds the store URL for this platform. `Err(InvalidArgument)` when the id this platform
    /// requires is missing or blank.
    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError>;
}

/// Opens a URL outside the app. The real one is the NSH host's `openUrl` (nsh-core's ambient
/// `open_url`); embeddings provide it and tests provide a fake.
pub trait UrlOpener: Send + Sync {
    /// Opens `url` in whatever app handles it; `Err` when it did not open.
    fn open_url(&self, url: &str) -> BackendFuture<'_, Result<(), InAppReviewError>>;
}
