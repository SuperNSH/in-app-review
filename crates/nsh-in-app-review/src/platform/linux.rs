//! Linux: the OS ships no app store, so no review flow runs here and no listing exists to open.
//!
//! A Linux store fallback would go through the host's `openUrl` if a store ever exists.

use std::future::ready;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// The Linux backend: nothing is available, so each call answers with a coded error.
pub(crate) struct NativeBackend;

impl Backend for NativeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(Ok::<bool, InAppReviewError>(false)))
    }

    fn start_review(&self, _done: ReviewDone) -> Result<(), InAppReviewError> {
        // No flow started, so `done` stays uncalled per the Backend contract.
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }

    fn store_listing_url(
        &self,
        _options: &StoreListingOptions,
    ) -> Result<String, InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }
}
