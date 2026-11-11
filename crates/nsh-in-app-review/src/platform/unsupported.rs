//! A target with no review backend: nothing is available, no flow starts, no store listing exists.

use std::future::ready;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// The backend of a target with none: every call says so with `Err(NotAvailable)`.
pub(crate) struct UnsupportedBackend;

impl Backend for UnsupportedBackend {
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
