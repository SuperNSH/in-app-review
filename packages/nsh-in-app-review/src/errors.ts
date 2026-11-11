/** The codes a review rejection carries. Apps match on `code`. */
export type InAppReviewErrorCode =
  | "ERR_IN_APP_REVIEW_NOT_AVAILABLE"
  | "ERR_IN_APP_REVIEW_CANCELLED"
  | "ERR_IN_APP_REVIEW_IN_PROGRESS"
  | "ERR_IN_APP_REVIEW_BACKEND"
  | "ERR_IN_APP_REVIEW_INVALID_ARGUMENT";

/** Same wording as the Rust crate's messages. None holds user data. */
const MESSAGES: Record<InAppReviewErrorCode, string> = {
  ERR_IN_APP_REVIEW_NOT_AVAILABLE: "The platform has no in-app review flow here. Open the store listing instead.",
  ERR_IN_APP_REVIEW_CANCELLED: "The review flow was interrupted before it completed.",
  ERR_IN_APP_REVIEW_IN_PROGRESS: "Another review flow is already running. Wait for it to finish.",
  ERR_IN_APP_REVIEW_BACKEND: "The platform's review service or URL opener failed.",
  ERR_IN_APP_REVIEW_INVALID_ARGUMENT: "The store id this platform requires is missing or empty.",
};

const KNOWN = new Set<string>(Object.keys(MESSAGES));

/** A rejection of a review call, an availability query or a store listing. */
export class InAppReviewError extends Error {
  readonly code: InAppReviewErrorCode;

  constructor(code: InAppReviewErrorCode) {
    super(MESSAGES[code]);
    this.name = "InAppReviewError";
    this.code = code;
  }
}

/** The error for a known code. */
export function inAppReviewError(code: InAppReviewErrorCode): InAppReviewError {
  return new InAppReviewError(code);
}

/**
 * Whether `value` is one of the five codes. Every code is a string at runtime, so a
 * `string | InAppReviewErrorCode` union cannot discriminate without this membership check.
 */
export function isInAppReviewErrorCode(value: string): value is InAppReviewErrorCode {
  return KNOWN.has(value);
}

/**
 * Turns whatever the native side or a host threw into a coded `InAppReviewError`. A host's
 * rejection carries `ERR_NSH_HOST_ERROR`, and its message starts with the code, as
 * `ERR_IN_APP_REVIEW_CANCELLED: text`. Anything unknown is a backend failure.
 */
export function asInAppReviewError(error: unknown): InAppReviewError {
  if (error instanceof InAppReviewError) return error;
  const raw = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";
  if (code === "ERR_NSH_HOST_ERROR") {
    const named = /^(ERR_IN_APP_REVIEW_[A-Z_]+): /.exec(message)?.[1];
    return named !== undefined && KNOWN.has(named)
      ? inAppReviewError(named as InAppReviewErrorCode)
      : inAppReviewError("ERR_IN_APP_REVIEW_BACKEND");
  }
  const known = KNOWN.has(code);
  return known ? inAppReviewError(code as InAppReviewErrorCode) : inAppReviewError("ERR_IN_APP_REVIEW_BACKEND");
}
