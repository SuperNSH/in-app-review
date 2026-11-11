import { expect, test } from "nsh/test";
import {
  InAppReview,
  memoryBackend,
  memoryQuotaTracker,
  type MemoryQuotaTracker,
  type ReviewBackend,
} from "../src";

/** The window the quota rolls over: 365 days of seconds. */
const WINDOW = 365 * 24 * 3600;

/** Yields until `ready` holds, so a started call reaches its prompt. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn += 1) await Promise.resolve();
  if (!ready()) throw new Error("the wait never ended");
}

/** A tracker with three requests inside the window: full. */
function fullQuota(): MemoryQuotaTracker {
  const quota = memoryQuotaTracker();
  const now = quota.now();
  quota.record(now);
  quota.record(now);
  quota.record(now);
  return quota;
}

test("quota allows three requests per 365 days", async () => {
  // The tracker itself: three timestamps inside one window fill it, whenever they fall.
  const quota = memoryQuotaTracker();
  const now = quota.now();
  for (const day of [0, 1, 2]) {
    expect(quota.canRequest(now + day * 24 * 3600)).toBe(true);
    quota.record(now + day * 24 * 3600);
  }
  expect(quota.canRequest(now + 100)).toBe(false);

  // And through the service: three flows run, one per request.
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  for (let request = 0; request < 3; request += 1) {
    const flow = review.requestReview();
    await until(() => backend.promptPending());
    backend.finishPrompt(true);
    expect(await flow).toBe(true);
  }
  expect(backend.prompts()).toBe(3);
});

test("quota suppresses the fourth request", async () => {
  const backend = memoryBackend();
  const review = new InAppReview({ backend });
  for (let request = 0; request < 3; request += 1) {
    const flow = review.requestReview();
    await until(() => backend.promptPending());
    backend.finishPrompt(true);
    expect(await flow).toBe(true);
  }
  // The fourth inside the window is suppressed with `false`, and the OS is never touched:
  // no flow starts.
  expect(await review.requestReview()).toBe(false);
  expect(backend.prompts()).toBe(3);
});

test("quota frees a slot after 365 days", async () => {
  // The tracker itself: a full window admits again once a record is strictly older than it.
  const quota = memoryQuotaTracker();
  const now = quota.now();
  quota.record(now - 100);
  quota.record(now - 50);
  quota.record(now - 10);
  expect(quota.canRequest(now)).toBe(false);
  const later = now - 100 + WINDOW + 1;
  expect(quota.canRequest(later)).toBe(true);
  quota.record(later);
  expect(quota.canRequest(later + 1)).toBe(false);

  // Through the service: records older than the window no longer count against a request.
  const backend = memoryBackend();
  const old = memoryQuotaTracker();
  const at = old.now();
  for (let seed = 0; seed < 3; seed += 1) old.record(at - WINDOW - 1);
  const review = new InAppReview({ backend, quota: old });
  const flow = review.requestReview();
  await until(() => backend.promptPending());
  backend.finishPrompt(true);
  expect(await flow).toBe(true);
  expect(backend.prompts()).toBe(1);
});

test("quota is checked before any backend call", async () => {
  const memory = memoryBackend();
  let availabilityReads = 0;
  const backend: ReviewBackend = {
    ...memory,
    isAvailable: async () => {
      availabilityReads += 1;
      return memory.isAvailable();
    },
  };
  const review = new InAppReview({ backend, quota: fullQuota() });
  expect(await review.requestReview()).toBe(false);
  expect(availabilityReads).toBe(0);
  expect(memory.prompts()).toBe(0);
});

test("a failed hand over consumes no quota", async () => {
  const backend = memoryBackend();
  const quota = memoryQuotaTracker();
  const at = quota.now();
  quota.record(at - 1000);
  quota.record(at - 500);
  const review = new InAppReview({ backend, quota });
  // The hand-over fails before any flow starts: the call errs, and the attempt leaves no
  // record behind.
  backend.failNextPrompt("ERR_IN_APP_REVIEW_BACKEND");
  await expect(review.requestReview()).rejects.toMatchObject({ code: "ERR_IN_APP_REVIEW_BACKEND" });
  expect(backend.prompts()).toBe(0);

  // The two seeded records plus this one fill the window: the failure consumed nothing.
  const flow = review.requestReview();
  await until(() => backend.promptPending());
  backend.finishPrompt(true);
  expect(await flow).toBe(true);
  expect(backend.prompts()).toBe(1);
  expect(quota.canRequest(quota.now())).toBe(false);
});
