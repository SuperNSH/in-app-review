# Parity

One row per public API of the two references: `in_app_review` (Flutter) and `react-native-in-app-review` (React Native). Our surface is `InAppReview` in Rust (`is_available`, `request_review`, `open_store_listing`) and the same methods in camelCase on the TS `InAppReview`.

Status key: **test in both languages** — the Rust crate and the TS package, with the test suites of both, are being landed in this same working session (this build); nothing is pushed and no CI run has happened, so per AGENTS.md every row's status stays unverified until CI passes on `master`. **not implemented** — no code; the row says why. At any read time the tree may hold all, part or none of this landing; read the status column as what this build is landing, not as an independently verified fact.

| Reference API | Ours | What ours does | Status |
|---|---|---|---|
| Flutter `isAvailable()` | `is_available()` / `isAvailable()` | Asks the platform backend whether the OS review flow exists on this device. Apple and Android answer from the OS; Windows, Linux and web answer `false`. Returns `Result<bool>`: failures are coded errors, not exceptions. | test in both languages |
| Flutter `requestReview()` | `request_review()` / `requestReview()` | One flow at a time — a second call while one runs is `Err(InProgress)`. Unavailable is `Err(NotAvailable)`. Our quota exhausted is `Ok(false)` and the OS is never touched — quota suppression is the only `Ok(false)`. Otherwise the backend runs the flow and we answer with its outcome. `Ok(true)` means the flow was handed over and, where the backend has a task to await, it completed with no error signal — never a claim that the OS showed anything: Apple returns as soon as the request is handed to the OS (StoreKit has no callback), and Android's Play task finishes the same way whether the user completed or dismissed the flow, so it carries no completed-vs-dismissed signal. A flow interrupted before the backend's task answered is `Err(Cancelled)`. | test in both languages |
| Flutter `openStoreListing({appStoreId, microsoftStoreId})` | `open_store_listing(&StoreListingOptions)` / `openStoreListing(options)` | Same two optional ids (`app_store_id`, `microsoft_store_id`). The backend builds the platform store URL (formats below) and the opener opens it. An id that is missing or blank where the platform requires it is `Err(InvalidArgument)`. | test in both languages |
| React Native `RequestInAppReview()` | `request_review()` / `requestReview()` | Same flow as the Flutter `requestReview` row. RN resolves a `Promise<boolean>`; ours returns `Result<bool>`. RN has no guard against overlapping calls; ours answers `Err(InProgress)`. | test in both languages |
| React Native `isAvailable()` | `is_available()` / `isAvailable()` | RN's is synchronous and guesses from the platform and OS version. Ours is async because it asks the platform backend, and reports failure as a coded error instead of throwing. | test in both languages |
| React Native `requestInAppCommentAppGallery()` | — | Not implemented. It opens Huawei AppGallery's in-app comment sheet, which exists only on HMS devices. Huawei AppGallery is not a target store for this crate; Apple, Google Play and Microsoft Store cover the platforms in scope. | not implemented |

## Store fallback

Only iOS, Android and macOS (Apple bridge) have a native prompt. Everywhere else `is_available` is `false`, `request_review` is `Err(NotAvailable)`, and the store listing is the whole feature: Windows opens the Microsoft Store, web opens a store page in a browser tab, Linux has no store to open.

Every listing on every platform goes through the NSH host's `openUrl` (nsh-core's ambient `open_url`) behind the `UrlOpener` trait — embeddings provide the host opener, tests provide a fake. URL formats per platform:

| Platform | URL |
|---|---|
| Apple (iOS, macOS) | `itms-apps://itunes.apple.com/app/id{app_store_id}?action=write-review` |
| Windows | `ms-windows-store://pdp/?ProductId={microsoft_store_id}` |
| Web (wasm) | `https://apps.apple.com/app/id{app_store_id}` when `app_store_id` is set, else `https://www.microsoft.com/store/productId/{microsoft_store_id}`; neither set is `Err(InvalidArgument)` |
| Android | `https://play.google.com/store/apps/details?id={package}` with the running app's package id where the platform exposes it; unavailable is `Err(InvalidArgument)` |
| Linux | no store listing: `Err(NotAvailable)` |

## Quota

iOS limits the prompt to 3 shows per 365 days per app, enforced by the OS and never reported to the app. We count the same limit client-side — `MemoryQuotaTracker`, at most 3 requests per rolling window of 365 days — and answer `Ok(false)` without touching the OS once ours is exhausted. The counter is a client-side policy: it can only refuse more than the OS, never less, and it resets if the app's data is cleared. Embeddings substitute their own policy with `InAppReview::with_quota`.

Android's quota belongs to Google Play: undocumented, enforced server-side, invisible to the app. We make no client-side claim about it beyond our own counter, which still applies everywhere as our conservative default.
