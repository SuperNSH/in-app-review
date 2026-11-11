//! Apple (iOS and macOS): StoreKit's review request, and the App Store listing URL.

use std::future::ready;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// The backend of an Apple target: StoreKit carries the review flow.
pub(crate) struct NativeBackend;

/// Hands the review request to StoreKit. The replacements need a window scene or view this crate
/// has no path to, so the deprecated scene-less entry stays.
#[allow(deprecated)]
fn request_review() {
    unsafe { objc2_store_kit::SKStoreReviewController::requestReview() };
}

impl Backend for NativeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        // requestReview exists since iOS 10.3 and macOS 10.14, below any SDK in use.
        Box::pin(ready(Ok::<bool, InAppReviewError>(true)))
    }

    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError> {
        request_review();
        // requestReview has no callback, so the flow ends with the handover itself.
        done(Ok(true));
        Ok(())
    }

    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError> {
        let id = options
            .app_store_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument))?;
        Ok(format!(
            "itms-apps://itunes.apple.com/app/id{id}?action=write-review"
        ))
    }
}
