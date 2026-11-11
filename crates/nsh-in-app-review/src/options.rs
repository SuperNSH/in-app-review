//! The stores an app is listed in: the ids `open_store_listing` builds a URL from.

/// The store ids of one listing. Each platform's backend needs its own; a missing or blank one
/// there is `ERR_IN_APP_REVIEW_INVALID_ARGUMENT`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoreListingOptions {
    /// The Apple App Store id, as in `id123456789`. Apple and the web use it.
    pub app_store_id: Option<String>,
    /// The Microsoft Store product id, as in `9NBLGGH42NBS`. Windows and the web use it.
    pub microsoft_store_id: Option<String>,
}
