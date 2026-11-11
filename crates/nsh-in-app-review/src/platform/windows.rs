//! Windows: no OS review prompt exists, so nothing is available and no flow starts; the Microsoft
//! Store listing is the only review path.
//!
//! This backend only builds the listing URL. The host's `openUrl` ([`crate::backend::UrlOpener`])
//! opens it; Windows needs no WinRT call here, so the crate adds no Windows dependency.

use std::future::ready;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

/// The Windows backend. The platform gives it nothing to hold, hence the unit struct.
pub(crate) struct NativeBackend;

impl Backend for NativeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(ready(Ok::<bool, InAppReviewError>(false)))
    }

    fn start_review(&self, _done: ReviewDone) -> Result<(), InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }

    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError> {
        // The Store's product-page protocol; ProductId is the listing's identity, as in
        // 9NBLGGH42NBS. A blank id cannot name a listing, so it is the same as none.
        options
            .microsoft_store_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| format!("ms-windows-store://pdp/?ProductId={id}"))
            .ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument))
    }
}
