//! The web: browsers have no OS review flow, so availability is false and no flow starts. The
//! store listing is a plain URL; opening it (a `window.open` in a web host) is the host opener's
//! job, never this file's.

use std::future::ready;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// The web backend: the store listing exists; the review flow does not.
pub(crate) struct NativeBackend;

impl Backend for NativeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(Ok::<bool, InAppReviewError>(false)))
    }

    fn start_review(&self, _done: ReviewDone) -> Result<(), InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }

    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError> {
        // Apple first: one listing wins when both ids are set.
        if let Some(id) = non_blank(options.app_store_id.as_deref()) {
            return Ok(format!("https://apps.apple.com/app/id{id}"));
        }
        if let Some(id) = non_blank(options.microsoft_store_id.as_deref()) {
            return Ok(format!("https://www.microsoft.com/store/productId/{id}"));
        }
        Err(InAppReviewError::new(ErrorKind::InvalidArgument))
    }
}

/// The id, trimmed; `None` when missing or blank. A blank id would build a URL to nowhere.
fn non_blank(id: Option<&str>) -> Option<&str> {
    let id = id?.trim();
    (!id.is_empty()).then_some(id)
}
