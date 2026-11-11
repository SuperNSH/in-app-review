//! In-app review for Native Shell apps: the OS's prompt on Apple and Android, the store listing
//! everywhere.
//!
//! [`InAppReview`] follows Flutter's `in_app_review`: ask what the device can do, request the
//! review flow, open the store listing as the fallback. Each call resolves exactly once, with
//! `Ok(true)`, `Ok(false)` or an [`InAppReviewError`] with a stable code.

mod backend;
mod error;
mod fake;
mod native;
mod options;
mod platform;
mod quota;
mod review;

use nsh_core::prelude::*;

pub use backend::{Backend, BackendFuture, ReviewDone, UrlOpener};
pub use error::{ErrorKind, InAppReviewError};
pub use fake::{FakeBackend, FakeOpener};
pub use native::{NativeInAppReview, NativeStoreListingOptions};
pub use options::StoreListingOptions;
pub use quota::{MemoryQuotaTracker, QuotaTracker};
pub use review::InAppReview;

/// The crate's UI set: what TSX imports from `nsh-in-app-review/native`.
#[native_module("nsh-in-app-review/native")]
fn native(registry: &mut Registry) {
    registry.class::<NativeInAppReview>();
}
