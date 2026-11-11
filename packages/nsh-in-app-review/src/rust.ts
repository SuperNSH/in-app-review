import { openUrl } from "nsh";
import { NativeInAppReview } from "nsh-in-app-review/native";
import type { ReviewBackend, UrlOpener } from "./backend";
import { asInAppReviewError, inAppReviewError } from "./errors";
import type { StoreListingOptions } from "./options";

/**
 * The Rust crate's review flow (`nsh-in-app-review/native`). The app or package must list the
 * crate under `"rust"` in `nsh.json`; importing this module without it fails the bundle. The
 * gate and the quota run on the Rust side too, with the same rules as the TS service's, so
 * both enforce one flow at a time and three requests per rolling 365 days.
 */
export function rustBackend(): ReviewBackend {
  return new RustBackend();
}

/**
 * The NSH host's `openUrl` as a `UrlOpener` — `nsh/device`'s, which the installed `nsh`
 * typings serve under the `nsh` module. Needs the `openUrl` capability in `nsh.json`.
 */
export function rustOpener(): UrlOpener {
  return { openUrl: (url) => openOutside(url) };
}

class RustBackend implements ReviewBackend {
  private readonly native = new NativeInAppReview();

  isAvailable(): Promise<boolean> {
    return this.settle(() => this.native.isAvailable());
  }

  startReview(): Promise<boolean> {
    return this.settle(() => this.native.requestReview());
  }

  // The native class builds and opens the listing URL itself (`openStoreListing`) and exposes
  // no way to read it, so this bridge has no URL to give and answers not-available.
  storeListingUrl(_options: StoreListingOptions): Promise<string> {
    return Promise.reject(inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE"));
  }

  private async settle<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw asInAppReviewError(error);
    }
  }
}

/** The host's answer: `opened: false` is a backend failure, as the Rust-side opener rules. */
async function openOutside(url: string): Promise<void> {
  let opened: boolean;
  try {
    opened = (await openUrl(url)).opened;
  } catch (error) {
    throw asInAppReviewError(error);
  }
  if (!opened) throw inAppReviewError("ERR_IN_APP_REVIEW_BACKEND");
}
