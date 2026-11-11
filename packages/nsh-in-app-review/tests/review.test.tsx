import { expect, test } from "nsh/test";
import { InAppReview, fakeOpener, inAppReviewError, memoryBackend, type ReviewBackend } from "../src";

/** Yields until `ready` holds, so a started call reaches its prompt. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn += 1) await Promise.resolve();
  if (!ready()) throw new Error("the wait never ended");
}

/** Lets a settled answer reach the gate, which frees itself a microtask later. */
async function delivered(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

/** An Apple-shaped backend: StoreKit has no callback, so the flow ends with the hand-over. */
const handOverBackend: ReviewBackend = {
  isAvailable: async () => true,
  startReview: async () => true,
  storeListingUrl: async () => "https://example.com/store-listing",
};

/** A platform with no review flow and no store, the shape of the crate's unsupported backend. */
const noStoreBackend: ReviewBackend = {
  isAvailable: async () => false,
  startReview: () => {
    throw inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE");
  },
  storeListingUrl: async () => {
    throw inAppReviewError("ERR_IN_APP_REVIEW_NOT_AVAILABLE");
  },
};

test("request review has no signal that the prompt showed", async () => {
  // The answer fires at hand-over, before anything could show: `true` is all the API says,
  // and it says nothing about a prompt appearing.
  const handed = new InAppReview({ backend: handOverBackend });
  expect(await handed.requestReview()).toBe(true);
  expect(await handed.isAvailable()).toBe(true);

  // A waited flow ends in the same `true`: no "shown" bit exists anywhere.
  const backend = memoryBackend();
  const waited = new InAppReview({ backend });
  const flow = waited.requestReview();
  await until(() => backend.promptPending());
  backend.finishPrompt(true);
  expect(await flow).toBe(true);
});

test("second request while a flow is open is in progress", async () => {
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  const first = review.requestReview();
  await until(() => backend.promptPending());
  await expect(review.requestReview()).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_IN_PROGRESS",
  });
  expect(backend.prompts()).toBe(1);
  backend.finishPrompt(true);
  expect(await first).toBe(true);
});

test("cancelled flow resolves once with cancelled", async () => {
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  const flow = review.requestReview();
  await until(() => backend.promptPending());
  expect(backend.finishPrompt("ERR_IN_APP_REVIEW_CANCELLED")).toBe(true);
  await expect(flow).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_CANCELLED" });
  // The flow answered once; a second answer has no call left to resolve.
  expect(backend.finishPrompt("ERR_IN_APP_REVIEW_CANCELLED")).toBe(false);

  const next = review.requestReview();
  await until(() => backend.promptPending());
  backend.finishPrompt(true);
  expect(await next).toBe(true);
});

test("unsupported platforms report not available", async () => {
  const opener = fakeOpener();
  const review = new InAppReview({ backend: noStoreBackend, opener });
  expect(await review.isAvailable()).toBe(false);
  await expect(review.requestReview()).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  });
  await expect(review.openStoreListing({})).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  });
  expect(opener.lastOpened()).toBeUndefined();

  // A platform whose flow exists but answers unavailable says the same, with no prompt.
  const memory = memoryBackend();
  memory.setAvailable(false);
  const unavailable = new InAppReview({ backend: memory });
  await expect(unavailable.requestReview()).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  });
  expect(memory.prompts()).toBe(0);
});

test("every call resolves exactly once", async () => {
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  // A success: one answer resolves the call once; a second answer has nothing to resolve.
  const first = review.requestReview();
  await until(() => backend.promptPending());
  await expect(review.requestReview()).rejects.toMatchObject({
    code: "ERR_IN_APP_REVIEW_IN_PROGRESS",
  });
  expect(backend.finishPrompt(true)).toBe(true);
  expect(await first).toBe(true);
  expect(backend.finishPrompt(false)).toBe(false);

  // A coded error: resolved once, and the gate frees for the next call.
  const failed = review.requestReview();
  await until(() => backend.promptPending());
  expect(backend.finishPrompt("ERR_IN_APP_REVIEW_BACKEND")).toBe(true);
  await expect(failed).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_BACKEND" });

  // A cancel: resolved once with its code.
  const cancelled = review.requestReview();
  await until(() => backend.promptPending());
  expect(backend.finishPrompt("ERR_IN_APP_REVIEW_CANCELLED")).toBe(true);
  await expect(cancelled).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_CANCELLED" });

  // The three flows above spent the quota: the suppressed call resolves once, with `false`.
  expect(await review.requestReview()).toBe(false);
  expect(backend.prompts()).toBe(3);
});

test("a dropped awaiter still settles and frees the gate", async () => {
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  // The caller fires and forgets after the hand-over; the system's answer still ends the flow.
  void review.requestReview();
  await until(() => backend.promptPending());
  expect(backend.finishPrompt(true)).toBe(true);
  await delivered();

  // The answer freed the gate, so the next call runs instead of waiting forever.
  const next = review.requestReview();
  await until(() => backend.promptPending());
  expect(backend.prompts()).toBe(2);
  backend.finishPrompt(true);
  expect(await next).toBe(true);
});

test("an availability error reaches the caller", async () => {
  const backend = memoryBackend();
  backend.setAvailable("ERR_IN_APP_REVIEW_BACKEND");
  const review = new InAppReview({ backend });
  await expect(review.isAvailable()).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_BACKEND" });
  await expect(review.requestReview()).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_BACKEND" });
  expect(backend.prompts()).toBe(0);
});
