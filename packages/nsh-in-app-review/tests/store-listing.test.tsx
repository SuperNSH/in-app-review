import { expect, test } from "nsh/test";
import {
  InAppReview,
  fakeOpener,
  inAppReviewError,
  memoryBackend,
  type ReviewBackend,
  type StoreListingOptions,
} from "../src";

/** The id trimmed; undefined when missing or blank. A blank id would build a URL to nowhere. */
function nonBlank(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The platforms the CONTRACT (docs/parity.md) names; the android one stands in for the running
 * app's package with a fixed id. */
type Platform = "apple" | "windows" | "web" | "android" | "linux";

const PACKAGE = "com.example.app";

/** A backend that builds listing URLs by one platform's rule. */
function platformBackend(platform: Platform): ReviewBackend {
  return {
    isAvailable: async () => platform === "apple",
    startReview: () => {
      throw inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE");
    },
    storeListingUrl: async (options: StoreListingOptions) => {
      const apple = nonBlank(options.appStoreId);
      const microsoft = nonBlank(options.microsoftStoreId);
      if (platform === "apple") {
        if (apple === undefined) throw inAppReviewError("ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
        return `itms-apps://itunes.apple.com/app/id${apple}?action=write-review`;
      }
      if (platform === "windows") {
        if (microsoft === undefined) throw inAppReviewError("ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
        return `ms-windows-store://pdp/?ProductId=${microsoft}`;
      }
      if (platform === "web") {
        // Apple first: one listing wins when both ids are set.
        if (apple !== undefined) return `https://apps.apple.com/app/id${apple}`;
        if (microsoft !== undefined) {
          return `https://www.microsoft.com/store/productId/${microsoft}`;
        }
        throw inAppReviewError("ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
      }
      if (platform === "android") {
        return `https://play.google.com/store/apps/details?id=${PACKAGE}`;
      }
      // Linux has no store to open.
      throw inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE");
    },
  };
}

const appleOptions: StoreListingOptions = { appStoreId: "123456789" };
const windowsOptions: StoreListingOptions = { microsoftStoreId: "9NBLGGH42NBS" };

test("open store listing requires the app store id on apple", async () => {
  const opener = fakeOpener();
  const review = new InAppReview({ backend: platformBackend("apple"), opener });
  // Neither id, or the other platform's id alone, names an Apple listing.
  await expect(review.openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
  });
  await expect(review.openStoreListing(windowsOptions)).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
  });
  expect(opener.lastOpened()).toBeUndefined();

  await review.openStoreListing(appleOptions);
  expect(opener.lastOpened()).toBe(
    "itms-apps://itunes.apple.com/app/id123456789?action=write-review",
  );
});

test("open store listing requires the microsoft store id on windows", async () => {
  const opener = fakeOpener();
  const review = new InAppReview({ backend: platformBackend("windows"), opener });
  await expect(review.openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
  });
  await expect(review.openStoreListing(appleOptions)).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
  });
  expect(opener.lastOpened()).toBeUndefined();

  await review.openStoreListing(windowsOptions);
  expect(opener.lastOpened()).toBe("ms-windows-store://pdp/?ProductId=9NBLGGH42NBS");
});

test("empty store ids are invalid arguments", async () => {
  const opener = fakeOpener();
  const reviews = (["apple", "windows", "web"] as const).map(
    (platform) => new InAppReview({ backend: platformBackend(platform), opener }),
  );
  // A blank id is the same as none, whatever whitespace it is blank with.
  const blanks: StoreListingOptions[] = [
    { appStoreId: "   " },
    { microsoftStoreId: "\t" },
    { appStoreId: " ", microsoftStoreId: " " },
  ];
  for (const options of blanks) {
    for (const review of reviews) {
      await expect(review.openStoreListing(options)).rejects.toMatchObject({
        code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
      });
    }
  }
  // Nothing was ever handed to the opener.
  expect(opener.lastOpened()).toBeUndefined();
});

test("store listing urls match the platform stores", async () => {
  const opener = fakeOpener();
  const opens = (platform: Platform) =>
    new InAppReview({ backend: platformBackend(platform), opener });

  await opens("apple").openStoreListing(appleOptions);
  expect(opener.lastOpened()).toBe(
    "itms-apps://itunes.apple.com/app/id123456789?action=write-review",
  );

  await opens("windows").openStoreListing(windowsOptions);
  expect(opener.lastOpened()).toBe("ms-windows-store://pdp/?ProductId=9NBLGGH42NBS");

  // The web takes either id, Apple's first when both are set.
  await opens("web").openStoreListing(appleOptions);
  expect(opener.lastOpened()).toBe("https://apps.apple.com/app/id123456789");
  await opens("web").openStoreListing(windowsOptions);
  expect(opener.lastOpened()).toBe("https://www.microsoft.com/store/productId/9NBLGGH42NBS");

  // Android's listing is the running app's package.
  await opens("android").openStoreListing({});
  expect(opener.lastOpened()).toBe(
    `https://play.google.com/store/apps/details?id=${PACKAGE}`,
  );

  // Linux has no store to open, and the opener stays untouched.
  await expect(opens("linux").openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  });
  expect(opener.lastOpened()).toBe(`https://play.google.com/store/apps/details?id=${PACKAGE}`);
});

test("open store listing surfaces a backend error when the opener fails", async () => {
  const backend = memoryBackend();
  const opener = fakeOpener();
  const review = new InAppReview({ backend, opener });
  opener.failNextOpen();
  await expect(review.openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_BACKEND",
  });
  expect(opener.lastOpened()).toBe("https://example.com/store-listing");

  // A URL that cannot be built never reaches the opener. A code in the five-code set stages a
  // rejection, any other string the URL; staged like the Rust suite's set_listing_url(Err(..)).
  backend.setListingUrl("ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
  await expect(review.openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
  });
  expect(opener.lastOpened()).toBe("https://example.com/store-listing");
});
