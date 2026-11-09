# nsh-in-app-review

Request the native in-app review prompt on iOS and Android, with a store fallback.

Part of the Native Shell (NSH) capability set. Same layout as the other SuperNSH repos: a Rust crate, docs in `docs/`, CI on GitHub Actions, and a web status page on GitHub Pages at https://supernsh.github.io/in-app-review/.

## Status

**Scaffold. Not implemented.** The crate exposes one placeholder function and one test. Nothing here talks to a device yet. Read [docs/brief.md](docs/brief.md) for the planned approach and [docs/parity.md](docs/parity.md) for what is done.

## Planned approach

Native bridge on iOS and Android. Desktop opens the store listing through openUrl instead.

## Layout

- `src/lib.rs`: placeholder crate.
- `docs/brief.md`: options, recommended path and edge cases from the research.
- `docs/decisions.md`: open decisions.
- `docs/parity.md`: feature status.
- `site/`: static status page, published by `.github/workflows/pages.yml`.
- `.zcode/workflow.ts`: the phases this area will run through.

## Checks

Every compile and test runs in GitHub Actions. Nothing is built on a developer machine.

## Licence

MIT. See [LICENSE](LICENSE).

Repository: https://github.com/SuperNSH/in-app-review
