import { expect, test } from "nsh/test";
import {
  InAppReview,
  asInAppReviewError,
  inAppReviewError,
  memoryBackend,
  type InAppReviewErrorCode,
} from "../src";

/**
 * The five codes the Rust crate defines, spelled out here as
 * crates/nsh-in-app-review/tests/errors.rs spells them, so the comparison below is explicit.
 */
const RUST_CODES: string[] = [
  "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  "ERR_IN_APP_REVIEW_CANCELLED",
  "ERR_IN_APP_REVIEW_IN_PROGRESS",
  "ERR_IN_APP_REVIEW_BACKEND",
  "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
];

/** The five codes the TS package defines (src/errors.ts). */
const TS_CODES: InAppReviewErrorCode[] = [
  "ERR_IN_APP_REVIEW_NOT_AVAILABLE",
  "ERR_IN_APP_REVIEW_CANCELLED",
  "ERR_IN_APP_REVIEW_IN_PROGRESS",
  "ERR_IN_APP_REVIEW_BACKEND",
  "ERR_IN_APP_REVIEW_INVALID_ARGUMENT",
];

/** Yields until `ready` holds, so a started call reaches its prompt. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn += 1) await Promise.resolve();
  if (!ready()) throw new Error("the wait never ended");
}

test("every error code matches the rust crate", () => {
  expect(TS_CODES).toEqual(RUST_CODES);
  for (const code of TS_CODES) {
    const error = inAppReviewError(code);
    expect(error.code).toBe(code);
    expect(error.message).not.toBe("");
    expect(error.name).toBe("InAppReviewError");
  }
});

test("every kind passes through the flow with its code", async () => {
  for (const code of TS_CODES) {
    // A fresh service per kind: the quota holds three, and the loop asks five times.
    const backend = memoryBackend();
    const review = new InAppReview({ backend });
    const flow = review.requestReview();
    await until(() => backend.promptPending());
    expect(backend.finishPrompt(code)).toBe(true);
    await expect(flow).rejects.toMatchObject({ code });
  }
});

test("a native rejection keeps its code, and an unknown one is a backend failure", () => {
  expect(asInAppReviewError({ code: "ERR_IN_APP_REVIEW_CANCELLED", message: "x" }).code).toBe(
    "ERR_IN_APP_REVIEW_CANCELLED",
  );
  expect(asInAppReviewError(inAppReviewError("ERR_IN_APP_REVIEW_IN_PROGRESS")).code).toBe(
    "ERR_IN_APP_REVIEW_IN_PROGRESS",
  );
  // A host rejection carries its code at the front of the message.
  expect(
    asInAppReviewError({ code: "ERR_NSH_HOST_ERROR", message: "ERR_IN_APP_REVIEW_BACKEND: text" })
      .code,
  ).toBe("ERR_IN_APP_REVIEW_BACKEND");
  expect(asInAppReviewError(new Error("boom")).code).toBe("ERR_IN_APP_REVIEW_BACKEND");
});
