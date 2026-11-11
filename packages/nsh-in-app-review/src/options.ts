/**
 * The store ids of one listing. Each platform's backend needs its own; a missing or blank one
 * there is `ERR_IN_APP_REVIEW_INVALID_ARGUMENT`.
 */
export interface StoreListingOptions {
  /** The Apple App Store id, as in `id123456789`. Apple and the web use it. */
  appStoreId?: string;
  /** The Microsoft Store product id, as in `9NBLGGH42NBS`. Windows and the web use it. */
  microsoftStoreId?: string;
}
