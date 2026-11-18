# nsh-in-app-review

Request the native in-app review prompt on iOS and Android, with a store fallback.

Part of the Native Shell (NSH) capability set. Same layout as the other SuperNSH repos: a Rust crate, a TypeScript package, docs in `docs/`, CI on GitHub Actions, and a web status page on GitHub Pages at https://supernsh.github.io/in-app-review/.

## Status

**Implemented and verified by CI on `master`.** The Rust crate in `crates/nsh-in-app-review` has the `InAppReview` service (one-flow gate, client-side quota of three requests per rolling 365 days, five coded error kinds), the `Backend` and `UrlOpener` traits with `FakeBackend`/`FakeOpener`, the `NativeInAppReview` class, and the platform bridges (Apple StoreKit, Android Play Review over JNI, Windows/Linux/web store fallbacks). The TypeScript package in `packages/nsh-in-app-review` mirrors the API and behavior. Every edge case E1-E12 in [docs/goals.md](docs/goals.md) has a test in both languages.

Verification: CI run https://github.com/SuperNSH/in-app-review/actions/runs/44400940982 passed all jobs: `rust` (fmt, clippy, `cargo test --all-targets`), `typescript` (`nsh check`, `nsh build` with no warnings, `nsh test`), and the cross-checks for `aarch64-apple-ios`, `aarch64-linux-android` and `wasm32-unknown-unknown`. The quota and in-progress tests were seen to fail once: run https://github.com/SuperNSH/in-app-review/actions/runs/44382186530 (commit 0f99e50, limit 4, doubled window, in-progress code changed) failed 7 TypeScript tests and did not pass the Rust job; the revert is green.

Limits:

- The bridges have never run on a device or emulator. AGENTS.md forbids that here and CI only compiles them (clippy cross-check). Blocked: needs real hardware or store accounts.
- Store URL formats are tested through fakes on Linux in CI. `the_real_apple_bridge_builds_the_listing_url` runs only on Apple hosts, and CI has no Apple test job (the iOS job is a clippy cross-check), so the real Apple, Windows and Android bridges are compile-checked only.
- The app must bundle `com.google.android.play:review` for the Android bridge.
- Do not call `request_review` from a button the user expects to do something: the OS may show nothing, and `Ok(true)` only means the request was handed over.

What 0.1.0 must do is in [docs/goals.md](docs/goals.md); per-API status against the two references is in [docs/parity.md](docs/parity.md).

## Approach

Native prompt on Apple platforms through StoreKit, on Android through the Play In-App Review API over JNI. Windows and web open the store listing through the host's `openUrl` instead; Linux has no store to open and answers `NotAvailable`.

## Layout

- `crates/nsh-in-app-review/`: the Rust crate — service, quota, errors, traits, fakes, bridges.
- `packages/nsh-in-app-review/`: the TypeScript mirror, same API and behavior, own tests.
- `docs/`: `goals.md` (the plan for 0.1.0), `parity.md` (feature status), `decisions.md`, `brief.md` (the research).
- `.github/workflows/`: `ci.yml` (rust, typescript, cross-check matrix) and `pages.yml` (publishes the site).
- `site/`: static status page, published to GitHub Pages.
- `AGENTS.md`, `LICENSE`: the repo's hard rules; MIT.
- `.refs/`: git-ignored reference checkout the docs cite.

## Checks

Every compile and test runs in GitHub Actions — fmt, clippy and tests for Rust; `nsh check` and `nsh test` for TypeScript; cross-checks for iOS, Android and wasm. Nothing is built on a developer machine.

## Licence

MIT. See [LICENSE](LICENSE).

Repository: https://github.com/SuperNSH/in-app-review
