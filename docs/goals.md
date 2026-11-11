# Goals: nsh-in-app-review

What 0.1.0 must do, what "done" means, and the edge cases the tests must cover. The plan is fixed: this document states it, it does not reopen it. Behavior details and store URL formats live in [parity.md](parity.md); the plan's sources are [brief.md](brief.md), AGENTS.md, and the references under `.refs/`.

## 1. Goals

- Request the native in-app review prompt where the OS has one: Apple (iOS and macOS) through StoreKit's `SKStoreReviewController` (`objc2-store-kit`), Android through Google Play's In-App Review API over JNI (`jni` + `ndk-context`, following the JNI pattern of the nsh-biometrics bridge). Apple's API has no completion callback, so its flow answers `Ok(true)` as soon as the request is handed to the OS; Android answers `Ok(true)` when `launchReviewFlow`'s task completes — the task finishes the same way whether the user completed or dismissed the flow, so it carries no completed-vs-dismissed signal — and a coded error when the task fails.
- Store fallback through the NSH host's `openUrl` (nsh-core's ambient `open_url`, behind the `UrlOpener` trait) on desktop, web, and anywhere without a native prompt. Windows opens the Microsoft Store, web opens a store page, Linux has no store to open and says so with `Err(NotAvailable)`. Embeddings provide the host opener; tests provide a fake.
- One Rust crate, `crates/nsh-in-app-review`, and one TypeScript package, `packages/nsh-in-app-review`, laid out like `nsh-biometrics`: `src/{lib,error,backend,review,quota,fake}.rs`, `src/platform/{mod,unsupported,apple,android,windows,linux,web}.rs`, Rust tests in `crates/nsh-in-app-review/tests/`, TS source and tests under `packages/nsh-in-app-review/`.
- The same API names and the same behavior in both languages: `is_available()` / `isAvailable()`, `request_review()` / `requestReview()`, `open_store_listing(&StoreListingOptions)` / `openStoreListing(options)` with `app_store_id` / `appStoreId` and `microsoft_store_id` / `microsoftStoreId`.
- The service adds the rules the OS APIs lack, identically in Rust and TS: one flow at a time (a second `request_review` while one runs is `Err(InProgress)`); a client-side quota of at most 3 requests per rolling 365 days (`MemoryQuotaTracker`, overridable with `InAppReview::with_quota`) that answers `Ok(false)` and touches no OS API once exhausted — quota suppression is the only `Ok(false)`, since neither StoreKit nor the Play task reports dismissal; and `Ok(true)` meaning the flow was handed over and, where the backend has a task to await, it completed with no error signal — never a claim that the OS showed anything.
- The API shape follows the references: Flutter's `in_app_review` (`isAvailable`, `requestReview`, `openStoreListing` with the two store ids) and React Native's `RequestInAppReview()` boolean promise; ours returns coded errors instead of throwing, and guards overlapping calls where RN does not.

## 2. Acceptance criteria

CI is the only place anything compiles or runs (AGENTS.md). Done means all of this passes on `master`:

- `cargo fmt --all -- --check` passes on the workspace.
- `cargo clippy --all-targets -- -D warnings` passes on the workspace.
- `cargo test --all-targets` passes on the workspace.
- The TypeScript package typechecks and tests pass: `nsh check` and `nsh test` in `packages/nsh-in-app-review`.
- `.github/workflows/ci.yml` runs both sides — the Rust gates and the TypeScript `nsh check` / `nsh test` job.
- Every behavior in section 4 has a test in BOTH languages: a Rust fn in `crates/nsh-in-app-review/tests/` and a TS `test()` whose title is the same sentence in words in `packages/nsh-in-app-review/tests/`. A test counts only after it has been seen to fail once (AGENTS.md).
- Every call resolves exactly once: a success, a coded error, or a cancel. No panics, no unwrapping remote data, no unbounded waits.
- Status claims in README and docs stay honest: a claim with no passing CI run is marked unverified. This document states goals, not status.

## 3. The error enum

`ErrorKind` is `#[non_exhaustive]`, `Debug + Clone + Copy + PartialEq + Eq + Hash`. `InAppReviewError { kind, status: Option<i64> }` mirrors `.refs/biometrics/crates/nsh-biometrics/src/error.rs`: `new(kind)`, `with_status(i64)`, `kind()`, `status()`, `code()`, and `Display` shows the message. Exactly five kinds, each with a stable code:

| Kind | Code | Returned when |
|---|---|---|
| `NotAvailable` | `ERR_IN_APP_REVIEW_NOT_AVAILABLE` | The platform has no native review flow — `request_review` on Windows, Linux and web, or after `is_available()` answered false — or no store listing exists there, as on Linux. |
| `Cancelled` | `ERR_IN_APP_REVIEW_CANCELLED` | A review flow was interrupted before it completed; the call still resolves exactly once, with this code. |
| `InProgress` | `ERR_IN_APP_REVIEW_IN_PROGRESS` | A second `request_review()` arrived while one flow is already running, because one flow runs at a time. |
| `Backend` | `ERR_IN_APP_REVIEW_BACKEND` | The platform's review flow or the host's URL opener failed underneath the library; `status` carries the platform's own code where it gives one. |
| `InvalidArgument` | `ERR_IN_APP_REVIEW_INVALID_ARGUMENT` | The store id this platform requires is missing or blank — `app_store_id` on Apple, `microsoft_store_id` on Windows, the package id on Android, either id on web. |

Every kind also has a one-sentence `message()` saying what to do about it.

## 4. Edge cases

Each case below is a named test pair: the Rust fn lives in `crates/nsh-in-app-review/tests/`, and the TypeScript `test()` title in `packages/nsh-in-app-review/tests/` is the same sentence in words.

| ID | Case | Rust test | TypeScript test |
|---|---|---|---|
| E1 | Client-side quota allows three requests per rolling 365 days | `quota_allows_three_requests_per_365_days` | "quota allows three requests per 365 days" |
| E2 | The fourth request inside the window is suppressed with `Ok(false)` | `quota_suppresses_the_fourth_request` | "quota suppresses the fourth request" |
| E3 | A request older than 365 days frees its slot | `quota_frees_a_slot_after_365_days` | "quota frees a slot after 365 days" |
| E4 | No signal whether the OS showed the prompt: `Ok(true)` is "handed over", not "shown" | `request_review_has_no_signal_that_the_prompt_showed` | "request review has no signal that the prompt showed" |
| E5 | One flow at a time; the second call is `ERR_IN_APP_REVIEW_IN_PROGRESS` | `second_request_while_a_flow_is_open_is_in_progress` | "second request while a flow is open is in progress" |
| E6 | A cancelled flow resolves exactly once with `ERR_IN_APP_REVIEW_CANCELLED` | `cancelled_flow_resolves_once_with_cancelled` | "cancelled flow resolves once with cancelled" |
| E7 | `open_store_listing` needs the platform's id: Apple wants `app_store_id`, Windows wants `microsoft_store_id` | `open_store_listing_requires_app_store_id_on_apple`; `open_store_listing_requires_microsoft_store_id_on_windows` | "open store listing requires the app store id on apple"; "open store listing requires the microsoft store id on windows" |
| E8 | A blank id is `ERR_IN_APP_REVIEW_INVALID_ARGUMENT` | `empty_store_ids_are_invalid_arguments` | "empty store ids are invalid arguments" |
| E9 | Store URLs match each store's format (the table in [parity.md](parity.md)) | `store_listing_urls_match_the_platform_stores` | "store listing urls match the platform stores" |
| E10 | Platforms with no prompt or store: `is_available` false; `request_review` and `open_store_listing` `Err(NotAvailable)` | `unsupported_platforms_report_not_available` | "unsupported platforms report not available" |
| E11 | An opener failure is `ERR_IN_APP_REVIEW_BACKEND` | `open_store_listing_surfaces_a_backend_error_when_the_opener_fails` | "open store listing surfaces a backend error when the opener fails" |
| E12 | Every error kind maps to its stable code, the Rust list equals the TS list, and every call resolves exactly once | `every_error_kind_has_a_stable_code`; `every_call_resolves_exactly_once` | "every error code matches the rust crate"; "every call resolves exactly once" |

### Coverage of brief.md's edge cases

- **iOS shows the prompt at most 3 times per 365 days; count client-side** — E1, E2, E3: `MemoryQuotaTracker` allows at most 3 requests per rolling `365*24*3600` seconds, and the fourth inside the window is `Ok(false)` with no OS request made.
- **Android's quota is set by Google Play and is not public** — no client-side signal exists to test; the library's own counter (E1–E3) applies on Android too as a conservative default that can only refuse more than the store, never less.
- **The prompt may show nothing, and the API gives no signal that it was shown** — E4: `Ok(true)` means the flow was handed over and, where the backend has a task, that the task completed with no error signal; `request_review`'s doc comment must say so.
- **Do not call it from a button press that the user expects to do something** — design guidance, not a testable behavior: the README and `request_review`'s doc comment must state it, and the one-flow-at-a-time rule (E5) is the guard the code provides.
