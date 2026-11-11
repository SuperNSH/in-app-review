//! The platform backends. Each target gets its own — the web's serves a store listing with no
//! review flow — and a target with none reports that nothing is available.

#[cfg(target_os = "android")]
mod android;
#[cfg(target_vendor = "apple")]
mod apple;
#[cfg(target_os = "linux")]
mod linux;
mod unsupported;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::Arc;

use crate::backend::Backend;
use unsupported::UnsupportedBackend;

/// The backend of the target this build runs on: the platform's, or [`UnsupportedBackend`].
pub(crate) fn native_backend() -> Arc<dyn Backend> {
    // The fallback is built on every target, so it stays compiled wherever a platform has one.
    platform_backend().unwrap_or_else(|| Arc::new(UnsupportedBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(target_vendor = "apple")]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    Some(Arc::new(apple::NativeBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(target_os = "android")]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    Some(Arc::new(android::NativeBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(target_os = "windows")]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    Some(Arc::new(windows::NativeBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(target_os = "linux")]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    Some(Arc::new(linux::NativeBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(target_arch = "wasm32")]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    Some(Arc::new(web::NativeBackend))
}

/// The platform's backend; `None` on a target with none.
#[cfg(not(any(
    target_vendor = "apple",
    target_os = "android",
    target_os = "windows",
    target_os = "linux",
    target_arch = "wasm32"
)))]
fn platform_backend() -> Option<Arc<dyn Backend>> {
    None
}
