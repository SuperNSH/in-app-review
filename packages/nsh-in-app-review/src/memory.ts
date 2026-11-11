import type { ReviewBackend, UrlOpener } from "./backend";
import { inAppReviewError, isInAppReviewErrorCode, type InAppReviewErrorCode } from "./errors";
import type { StoreListingOptions } from "./options";

/** The answers a memory backend starts with. Each stays until set again. */
export interface MemoryBackendConfig {
  /** What `isAvailable` answers: a boolean, or a code to reject with. Default `true`. */
  available?: boolean | InAppReviewErrorCode;
  /** What `storeListingUrl` answers: a URL, or a code to reject with. */
  listingUrl?: string | InAppReviewErrorCode;
}

/**
 * A backend the test drives: it finishes prompts and counts what was asked. Like the platform
 * flows, the prompt waits for its answer: call `finishPrompt`, as the system would.
 */
export interface MemoryBackend extends ReviewBackend {
  /**
   * Answers the waiting flow: `true` ran to its end, `false` dismissed without completing, or
   * a code to reject with. Returns `false` when none waits.
   */
  finishPrompt(answer: boolean | InAppReviewErrorCode): boolean;

  /** Whether a flow is waiting for its answer. */
  promptPending(): boolean;

  /** How many flows were started. */
  prompts(): number;

  /** The URL of the last successful `storeListingUrl`. */
  lastUrl(): string | undefined;

  /** Sets what `isAvailable` answers. */
  setAvailable(answer: boolean | InAppReviewErrorCode): void;

  /** Makes the next flow fail to start with the code, as a platform does when it cannot show one. */
  failNextPrompt(error: InAppReviewErrorCode): void;

  /** Sets what `storeListingUrl` answers: a code in the five-code set stages a rejection, any other string the URL. */
  setListingUrl(answer: string | InAppReviewErrorCode): void;
}

/** A memory backend, for tests and for apps that run without a store. */
export function memoryBackend(config: MemoryBackendConfig = {}): MemoryBackend {
  let available: boolean | InAppReviewErrorCode = config.available ?? true;
  let listingUrl: string | InAppReviewErrorCode =
    config.listingUrl ?? "https://example.com/store-listing";
  let nextStartError: InAppReviewErrorCode | undefined;
  let waiting: ((answer: boolean | InAppReviewErrorCode) => void) | null = null;
  let prompts = 0;
  let last: string | undefined;

  return {
    isAvailable: async () => {
      if (typeof available === "boolean") return available;
      throw inAppReviewError(available);
    },
    startReview: () => {
      // The throw before the promise is the seam's "no flow started": the caller counts nothing.
      if (nextStartError !== undefined) {
        const error = inAppReviewError(nextStartError);
        nextStartError = undefined;
        throw error;
      }
      prompts += 1;
      return new Promise<boolean>((resolve, reject) => {
        // A start over a waiting prompt drops it, as the Rust fake drops its ReviewDone: the
        // overwritten caller settles with Backend rather than hanging.
        waiting?.("ERR_IN_APP_REVIEW_BACKEND");
        waiting = (answer) => {
          if (typeof answer === "boolean") resolve(answer);
          else reject(inAppReviewError(answer));
        };
      });
    },
    storeListingUrl: async (_options: StoreListingOptions) => {
      // A staged member of the five-code set is a rejection; any other string is the URL. A
      // refused listing is not a URL, so it never reaches `lastUrl`.
      if (isInAppReviewErrorCode(listingUrl)) throw inAppReviewError(listingUrl);
      last = listingUrl;
      return listingUrl;
    },
    finishPrompt: (answer) => {
      const done = waiting;
      waiting = null;
      done?.(answer);
      return done !== null;
    },
    promptPending: () => waiting !== null,
    prompts: () => prompts,
    lastUrl: () => last,
    setAvailable: (answer) => {
      available = answer;
    },
    failNextPrompt: (error) => {
      nextStartError = error;
    },
    setListingUrl: (answer) => {
      listingUrl = answer;
    },
  };
}

/** The answers a memory opener starts with. */
export interface MemoryOpenerConfig {
  /** The code every open rejects with, until `setOpenResult` says otherwise. Undefined opens everything. */
  openError?: InAppReviewErrorCode;
}

/** An opener the test drives: it records what it was asked to open. */
export interface MemoryOpener extends UrlOpener {
  /** Sets what every open answers, until set again. Undefined opens everything. */
  setOpenResult(answer?: InAppReviewErrorCode): void;

  /** Makes the next open fail with `ERR_IN_APP_REVIEW_BACKEND`. */
  failNextOpen(): void;

  /** The URL of the last open. */
  lastOpened(): string | undefined;
}

/** A memory opener, for tests and for embeddings that route listings their own way. */
export function fakeOpener(config: MemoryOpenerConfig = {}): MemoryOpener {
  let openError = config.openError;
  let nextOpenError: InAppReviewErrorCode | undefined;
  let last: string | undefined;

  return {
    openUrl: async (url: string) => {
      last = url;
      const error = nextOpenError ?? openError;
      nextOpenError = undefined;
      if (error !== undefined) throw inAppReviewError(error);
    },
    setOpenResult: (answer) => {
      openError = answer;
    },
    failNextOpen: () => {
      nextOpenError = "ERR_IN_APP_REVIEW_BACKEND";
    },
    lastOpened: () => last,
  };
}
