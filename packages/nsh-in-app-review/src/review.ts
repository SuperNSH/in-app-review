import type { ReviewBackend, UrlOpener } from "./backend";
import { asInAppReviewError, inAppReviewError } from "./errors";
import type { StoreListingOptions } from "./options";
import { type QuotaTracker, memoryQuotaTracker, unixNow } from "./quota";
import { rustBackend, rustOpener } from "./rust";

/**
 * In-app review with the OS's prompt, and the store listing as the fallback. It runs on the
 * Rust crate unless it is given another backend. One flow runs at a time, and each call
 * resolves exactly once.
 */
export class InAppReview {
  private readonly backend: ReviewBackend;
  private readonly opener: UrlOpener;
  private readonly quota: QuotaTracker;

  // `busy` lasts until the platform answers, even after the caller stopped waiting: the
  // system's answer ends a flow, not the caller going away.
  private busy = false;

  /**
   * Reviews through `backend`, opening listings through `opener`, with the default quota of
   * three requests per rolling 365 days; `quota` replaces that policy.
   */
  constructor(options: { backend?: ReviewBackend; opener?: UrlOpener; quota?: QuotaTracker } = {}) {
    this.backend = options.backend ?? rustBackend();
    this.opener = options.opener ?? rustOpener();
    this.quota = options.quota ?? memoryQuotaTracker();
  }

  /** Whether the OS review flow exists on this device. */
  async isAvailable(): Promise<boolean> {
    try {
      return await this.backend.isAvailable();
    } catch (error) {
      throw asInAppReviewError(error);
    }
  }

  /**
   * Shows the OS review flow and waits for its answer.
   *
   * Resolves `true` when the flow was handed over and, where the backend has a task to await,
   * it completed with no error signal — never a claim that the OS showed anything (on Apple
   * the answer fires at hand-over: StoreKit has no callback), so do not call this from a
   * button the user expects to do something. Resolves `false` when the quota refused (at most
   * three requests per rolling 365 days) and no request was made; the OS counts its own
   * limits besides ours. A second call while one flow runs rejects with
   * `ERR_IN_APP_REVIEW_IN_PROGRESS`; a flow interrupted before it completes rejects with
   * `ERR_IN_APP_REVIEW_CANCELLED`. A call that stops waiting leaves the flow to finish on
   * its own; the next one waits until it has.
   */
  async requestReview(): Promise<boolean> {
    if (this.busy) throw inAppReviewError("ERR_IN_APP_REVIEW_IN_PROGRESS");
    // The quota comes first: once it is spent, the OS is not asked at all.
    if (!this.quota.canRequest(unixNow())) return false;
    let available: boolean;
    try {
      available = await this.backend.isAvailable();
    } catch (error) {
      throw asInAppReviewError(error);
    }
    if (!available) throw inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE");
    // The availability await let another call take the flow gate meanwhile; only a free one starts.
    if (this.busy) throw inAppReviewError("ERR_IN_APP_REVIEW_IN_PROGRESS");
    this.busy = true;
    // Under the gate, counting and handing over are one step: no other call slips between
    // them, and a hand-over that starts nothing puts its count back.
    const now = unixNow();
    if (!this.quota.canRequest(now)) {
      this.busy = false;
      return false;
    }
    this.quota.record(now);
    let prompt: Promise<boolean>;
    try {
      prompt = this.backend.startReview();
    } catch (error) {
      // A throw before the promise is the seam's "no flow started": the gate frees and the
      // failed hand-over consumes no quota.
      this.busy = false;
      this.quota.unrecord(now);
      throw asInAppReviewError(error);
    }
    return new Promise<boolean>((resolve, reject) => {
      prompt.then(
        (value) => {
          this.busy = false;
          resolve(value);
        },
        (error) => {
          this.busy = false;
          reject(asInAppReviewError(error));
        },
      );
    });
  }

  /** Opens the platform's store listing: the backend builds its URL, the opener opens it. */
  async openStoreListing(options: StoreListingOptions = {}): Promise<void> {
    let url: string;
    try {
      url = await this.backend.storeListingUrl(options);
    } catch (error) {
      throw asInAppReviewError(error);
    }
    try {
      await this.opener.openUrl(url);
    } catch (error) {
      throw asInAppReviewError(error);
    }
  }
}
