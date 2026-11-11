import type { StoreListingOptions } from "./options";

/** What an `InAppReview` runs on: the Rust crate, or a memory backend in tests. */
export interface ReviewBackend {
  /** Whether the OS review flow exists on this device. */
  isAvailable(): Promise<boolean>;

  /**
   * Hands the flow to the OS and resolves exactly once when the system answers: `true` when it
   * ran to its end, `false` when it was dismissed without completing. A throw before the
   * returned promise means no flow started; a rejection means the flow itself failed.
   */
  startReview(): Promise<boolean>;

  /**
   * Builds the store URL for this platform. Rejects with `ERR_IN_APP_REVIEW_INVALID_ARGUMENT`
   * when the id this platform requires is missing or blank.
   */
  storeListingUrl(options: StoreListingOptions): Promise<string>;
}

/**
 * Opens a URL outside the app. The real one is the NSH host's `openUrl` (`nsh/device`'s);
 * embeddings provide it and tests provide a fake.
 */
export interface UrlOpener {
  /** Opens `url` in whatever app handles it; rejects when it did not open. */
  openUrl(url: string): Promise<void>;
}
