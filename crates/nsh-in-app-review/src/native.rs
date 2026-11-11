//! The review as TSX sees it: `NativeInAppReview`, a class whose async members reject with a
//! `code` on failure. Results are plain values; the prompt and the stores stay on the Rust side.

use std::sync::Arc;

use nsh_core::prelude::*;

use crate::{
    InAppReview, StoreListingOptions,
    backend::{BackendFuture, UrlOpener},
    error::{ErrorKind, InAppReviewError},
    platform::native_backend,
};

/// The stores an app is listed in, from TSX. Unset fields keep the defaults.
#[derive(JsObject, Clone, Debug, Default)]
pub struct NativeStoreListingOptions {
    /// The Apple App Store id, as in `id123456789`.
    pub app_store_id: Option<String>,
    /// The Microsoft Store product id, as in `9NBLGGH42NBS`.
    pub microsoft_store_id: Option<String>,
}

/// A review handle. Create one and keep it; every handle shares the platform's flow gate.
#[class]
pub struct NativeInAppReview {
    review: InAppReview,
}

/// The host's `openUrl` (nsh-core's ambient `open_url`) as a [`UrlOpener`].
struct HostOpener;

impl UrlOpener for HostOpener {
    fn open_url(&self, url: &str) -> BackendFuture<'_, Result<(), InAppReviewError>> {
        // The ambient call hands the URL to the engine, so it runs while the engine's runtime is
        // entered: here, in the JS call, before the first await.
        let answer = nsh_core::element::open_url(url.to_owned());
        Box::pin(async move {
            answer
                .await
                .then_some(())
                .ok_or_else(|| InAppReviewError::new(ErrorKind::Backend))
        })
    }
}

#[class]
impl NativeInAppReview {
    /// The platform's in-app review.
    pub fn new() -> NativeInAppReview {
        NativeInAppReview {
            review: InAppReview::new(native_backend(), Arc::new(HostOpener)),
        }
    }

    /// Whether the OS review flow exists on this device.
    pub async fn is_available(this: Instance<Self>) -> Result<bool, JsError> {
        let review = this.with(|native| native.review.clone());
        review.is_available().await.map_err(into_js)
    }

    /// Shows the OS review flow. Resolves `true` when the flow was handed over and, where the
    /// backend has a task to await, completed with no error signal — never a claim that the OS
    /// showed anything; `false` when the quota refused.
    pub async fn request_review(this: Instance<Self>) -> Result<bool, JsError> {
        let review = this.with(|native| native.review.clone());
        review.request_review().await.map_err(into_js)
    }

    /// Opens the platform's store listing with the ids given.
    pub async fn open_store_listing(
        this: Instance<Self>,
        options: Option<NativeStoreListingOptions>,
    ) -> Result<(), JsError> {
        let review = this.with(|native| native.review.clone());
        let options = options.unwrap_or_default();
        let options = StoreListingOptions {
            app_store_id: options.app_store_id,
            microsoft_store_id: options.microsoft_store_id,
        };
        review.open_store_listing(&options).await.map_err(into_js)
    }
}

impl Default for NativeInAppReview {
    fn default() -> Self {
        Self::new()
    }
}

/// The error a rejection carries: its message, and the `code` apps match on.
fn into_js(error: InAppReviewError) -> JsError {
    JsError::Error(error.kind().message().to_owned()).with_code(error.code())
}
