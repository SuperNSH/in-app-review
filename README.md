# nsh-in-app-review

Request the native in-app review prompt on iOS and Android, with a store fallback.

Part of the Native Shell (NSH) capability set. Same layout as the other SuperNSH repos: a Rust crate, a TypeScript package, docs in `docs/`, CI on GitHub Actions, and a web status page on GitHub Pages at https://supernsh.github.io/in-app-review/.

## Status

**Implemented, not yet verified by CI.** Everything landed in one working session: the Rust crate in `crates/nsh-in-app-review` — the `InAppReview` service with a one-flow gate and a client-side quota of three requests per rolling 365 days, five coded error kinds, the `Backend` and `UrlOpener` traits with `FakeBackend`/`FakeOpener`, the `NativeInAppReview` class, and five platform bridges (Apple StoreKit, Android Play Review over JNI, Windows/Linux/web store fallbacks) plus `UnsupportedBackend` — and the TypeScript mirror in `packages/nsh-in-app-review` with the same API and behavior. Tests: 21 in Rust, 20 in TypeScript.

The gates — `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --all-targets`, `nsh check`, `nsh test`, and local cross-target compiles for `aarch64-apple-ios` and `wasm32-unknown-unknown` — ran locally in that session and passed. No commit was made and no CI run has happened: the push to `master` produces the first real run, and until it passes nothing here is CI-verified.

Three limits, stated plainly:

- The bridges have never been exercised on real hardware or emulators. AGENTS.md forbids running them on a developer's machine, and CI does not run them on a device either.
- The local cross-compile for Android, Windows and Linux stopped at `ring`'s C dependency: no NDK clang, mingw or aarch64-linux-gnu-gcc on the machine. Cross-compiling them is what CI's cross-check job owns (`aarch64-apple-ios`, `aarch64-linux-android` with the NDK, `wasm32-unknown-unknown`).
- The app must bundle `com.google.android.play:review` for the Android bridge.

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
