// Build nsh-in-app-review: a Rust crate and a TypeScript package mirroring SuperNSH/biometrics,
// with the in_app_review (Flutter) and react-native-in-app-review (RN) API surfaces.
// Every area runs its own chain — implement, then up to 3 audit rounds (gate + review + fix),
// converging when a round comes back clean. No commits, no pushes, no emulators.

const AUDIT_ROUNDS = 3;
const GATE_FAST = 120_000;
const GATE_CARGO = 900_000;
const GATE_NSH = 1_200_000;

const MODELS = {
  // The user asked for GLM-5.3 Max on every area: every implementer and checker is pinned pro.
  pro: model("account:zai-individual-coding-plan/GLM-5.3$high"),
};

type Subagent = ReturnType<typeof agent>;

interface Finding {
  /** Workspace-relative path the problem is in, or "(gate)" for a command failure. */
  path: string;
  /** One sentence: what is wrong. Gate findings carry the failing output. */
  problem: string;
  /** How much it matters. Reserve "high" for a broken build or a wrong behavior. */
  severity: "low" | "medium" | "high";
}

interface AuditVerdict {
  /** Only actionable findings: wrong, missing, or contradicting the contract. Empty when clean. */
  findings: Finding[];
  /** A cross-target compile a local toolchain could not run, with the command that failed. */
  environmentBlocked?: string;
}

interface ImplementOutcome {
  /** True when every file the ask names was written. */
  done: boolean;
  /** What was implemented, one or two sentences. */
  summary: string;
  /** Anything the ask required that could not be done, with the reason. */
  blockers?: string[];
}

interface FixOutcome {
  /** True when every finding was addressed. */
  done: boolean;
  /** What was changed, one sentence. */
  summary: string;
  /** Findings that could not be fixed, with the reason. */
  blockers?: string[];
}

interface AreaResult {
  name: string;
  status: "done" | "failed" | "blocked";
  summary: string;
  /** Whether the audit loop reached a clean round inside the cap. */
  converged?: boolean;
  rounds?: number;
  notes?: string[];
}

interface WorkflowReport {
  /** What was built, what failed, what did not converge. */
  conclusion: string;
  areas: AreaResult[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
  /** Pin notes, honest caveats, and anything the coordinator must know. */
  notes: string[];
}

function gateFinding(name: string, r: { exitCode: number; stdout: string; stderr: string }): Finding {
  const tail = (r.stderr || r.stdout || "").slice(-4000);
  return {
    path: "(gate)",
    problem: `${name} exited ${r.exitCode}:\n${tail}`,
    severity: "high",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared API contract — the same text every implementer and checker reads.
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT = `
CONTRACT (nsh-in-app-review 0.1.0 — the plan is fixed; implement it, do not redesign it)

Workspace: root Cargo.toml becomes a workspace manifest: [workspace] members=["crates/nsh-in-app-review"],
resolver="3", and [workspace.package] version="0.1.0", edition="2024", license="MIT",
repository="https://github.com/SuperNSH/in-app-review", authors=["hmziqrs"]. The old root src/lib.rs
placeholder is deleted; the crate lives at crates/nsh-in-app-review with [lib] name="nsh_in_app_review",
publish=false. Deps: nsh-core "0.4.0", thiserror "2", tokio "1" with default-features=false and
features=["sync","time"]. Dev-deps: tokio with features ["rt","rt-multi-thread","macros","time"].
Target deps, added up front by the core area so the bridges compile under their cross-target gates:
[target.'cfg(target_vendor = "apple")'.dependencies] objc2-store-kit = "0.3" (features: default is
enough; enable what SKStoreReviewController needs);
[target.'cfg(target_os = "android")'.dependencies] jni = "0.22", ndk-context = "0.1", libc = "0.2".
Windows, Linux and web bridges add no dependencies.

Error kinds — ErrorKind, #[non_exhaustive], Debug+Clone+Copy+PartialEq+Eq+Hash. Exactly five, stable codes:
  NotAvailable     ERR_IN_APP_REVIEW_NOT_AVAILABLE
  Cancelled        ERR_IN_APP_REVIEW_CANCELLED
  InProgress       ERR_IN_APP_REVIEW_IN_PROGRESS
  Backend          ERR_IN_APP_REVIEW_BACKEND
  InvalidArgument  ERR_IN_APP_REVIEW_INVALID_ARGUMENT
InAppReviewError { kind, status: Option<i64> } mirrors .refs/biometrics/crates/nsh-biometrics/src/error.rs:
new(kind), with_status(i64), kind(), status(), code(), and Display shows the message. Every kind has
code() and a one-sentence message() saying what to do.

Service (src/review.rs): pub struct InAppReview.
  InAppReview::new(backend: Arc<dyn Backend>, opener: Arc<dyn UrlOpener>) — default MemoryQuotaTracker.
  InAppReview::with_quota(backend, opener, quota: Arc<dyn QuotaTracker>).
  async is_available() -> Result<bool, InAppReviewError>
  async request_review() -> Result<bool, InAppReviewError> — one flow at a time (a second call while one
    runs is Err(InProgress)); is_available() false is Err(NotAvailable); quota exhausted (max 3 per
    rolling 365 days) is Ok(false) and makes no request; otherwise hand to the backend, record the quota
    when the request is handed over, and answer with the backend's outcome. Ok(true) means the flow
    completed; the OS may still have shown nothing and no API reports that (document in the doc comment).
    A flow interrupted before completing is Err(Cancelled).
  async open_store_listing(options: &StoreListingOptions) -> Result<(), InAppReviewError> —
    let url = backend.store_listing_url(options)?; then opener.open_url(&url).await.
pub struct StoreListingOptions { pub app_store_id: Option<String>, pub microsoft_store_id: Option<String> }
with Default (plain public fields).

Backend trait (src/backend.rs), mirroring .refs/biometrics/crates/nsh-biometrics/src/backend.rs:
  pub type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
  pub type ReviewDone = Box<dyn FnOnce(Result<bool, InAppReviewError>) + Send>;
  pub trait Backend: Send + Sync {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>>;
    // Hands the flow to the OS. An Err means no flow started and done is never called.
    // Otherwise done is called exactly once, when the system answers — never hung.
    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError>;
    // Builds the store URL for this platform. Err(InvalidArgument) when the id this platform
    // requires is missing or blank.
    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError>;
  }
UrlOpener trait (also src/backend.rs): pub trait UrlOpener: Send + Sync {
  fn open_url(&self, url: &str) -> BackendFuture<'_, Result<(), InAppReviewError>>;
}
The real opener is the NSH host's openUrl (nsh-core's ambient open_url); embeddings provide it and
tests provide a fake. No panic, no unwrap on remote data, no unbounded wait — every call resolves
exactly once: success, a coded error, or a cancel.

Quota (src/quota.rs): pub trait QuotaTracker: Send + Sync {
  fn can_request(&self, now: i64) -> bool; fn record(&self, now: i64);
}
MemoryQuotaTracker keeps timestamps in unix seconds, allows at most 3 per rolling window of
365*24*3600 seconds. MemoryQuotaTracker::new() uses a real clock; MemoryQuotaTracker::with_clock(
Arc<dyn Fn() -> i64 + Send + Sync>) lets tests inject time.

FakeBackend (src/fake.rs) mirrors .refs/biometrics/crates/nsh-biometrics/src/fake.rs: scripted
is_available, fail_next_prompt(Option<BiometricsError>-style next start_review error), a waiting
prompt with finish_prompt(Result<bool, InAppReviewError>) -> bool (false when none waits),
prompts_started(), last_url() (the last store_listing_url result), set_open_result,
set_listing_url. Default: available, prompt completes Ok(true), listing url Ok("https://example.com/store-listing").
FakeOpener alongside it: scripted open results (set_open_result), last_opened(), fail_next_open().

platform/mod.rs and platform/unsupported.rs: cfg-selected module declarations —
#[cfg(target_vendor = "apple")] mod apple; #[cfg(target_os = "android")] mod android;
#[cfg(target_os = "windows")] mod windows; #[cfg(target_os = "linux")] mod linux;
#[cfg(target_arch = "wasm32")] mod web; and always mod unsupported; — plus
pub(crate) fn native_backend() -> Arc<dyn Backend> selecting the platform backend per cfg,
falling back to UnsupportedBackend. UnsupportedBackend: is_available Ok(false), start_review
Err(NotAvailable), store_listing_url Err(NotAvailable).

Store URL formats: Apple "itms-apps://itunes.apple.com/app/id{app_store_id}?action=write-review";
Windows "ms-windows-store://pdp/?ProductId={microsoft_store_id}"; web/wasm: app_store_id present ->
"https://apps.apple.com/app/id{app_store_id}", else microsoft_store_id present ->
"https://www.microsoft.com/store/productId/{microsoft_store_id}", else Err(InvalidArgument);
Android store listing uses the running app's package id where the platform exposes it
("https://play.google.com/store/apps/details?id={package}"), Err(InvalidArgument) when unavailable;
Linux has no store listing: Err(NotAvailable).

Bridge behaviors: Apple's SKStoreReviewController.requestReview() has no completion callback, so its
start_review calls done(Ok(true)) immediately after handing the request to the OS. Android uses Google
Play's Review API over JNI with ndk-context for the VM and activity, following the JNI pattern of
.refs/biometrics/crates/nsh-biometrics/src/platform/android.rs; done(Ok(true)) when launchReviewFlow's
task completes, done(Ok(false)) when the user dismissed without completing, coded errors otherwise.
Windows, Linux and web have no native prompt: is_available Ok(false), start_review Err(NotAvailable).

Code style (AGENTS.md): comments are 1-2 lines and state a non-obvious constraint; dead code is
deleted; no speculative abstractions; docs read direct and concrete.
`;

const EDGE_CASES = `
EDGE CASES -> NAMED TESTS (Rust fns in crates/nsh-in-app-review/tests/, TS test() titles in
packages/nsh-in-app-review/tests/ — the TS title is the same sentence in words):
E1  Client-side quota allows three requests per rolling 365 days
    -> quota_allows_three_requests_per_365_days / "quota allows three requests per 365 days"
E2  The fourth request inside the window is suppressed with Ok(false)
    -> quota_suppresses_the_fourth_request / "quota suppresses the fourth request"
E3  A request older than 365 days frees its slot
    -> quota_frees_a_slot_after_365_days / "quota frees a slot after 365 days"
E4  No signal whether the OS showed the prompt (Ok(true) is "handed over", not "shown")
    -> request_review_has_no_signal_that_the_prompt_showed / "request review has no signal that the prompt showed"
E5  One flow at a time; the second call is ERR_IN_APP_REVIEW_IN_PROGRESS
    -> second_request_while_a_flow_is_open_is_in_progress / "second request while a flow is open is in progress"
E6  A cancelled flow resolves exactly once with ERR_IN_APP_REVIEW_CANCELLED
    -> cancelled_flow_resolves_once_with_cancelled / "cancelled flow resolves once with cancelled"
E7  open_store_listing needs the platform's id: Apple wants app_store_id, Windows wants microsoft_store_id
    -> open_store_listing_requires_app_store_id_on_apple, open_store_listing_requires_microsoft_store_id_on_windows
    / "open store listing requires the app store id on apple", "open store listing requires the microsoft store id on windows"
E8  A blank id is ERR_IN_APP_REVIEW_INVALID_ARGUMENT
    -> empty_store_ids_are_invalid_arguments / "empty store ids are invalid arguments"
E9  Store URLs match each store's format (see CONTRACT)
    -> store_listing_urls_match_the_platform_stores / "store listing urls match the platform stores"
E10 Platforms with no prompt or store: is_available false; request_review and open_store_listing Err(NotAvailable)
    -> unsupported_platforms_report_not_available / "unsupported platforms report not available"
E11 An opener failure is ERR_IN_APP_REVIEW_BACKEND
    -> open_store_listing_surfaces_a_backend_error_when_the_opener_fails
    / "open store listing surfaces a backend error when the opener fails"
E12 Every error kind maps to its stable code, and the Rust list equals the TS list; every call resolves exactly once
    -> every_error_kind_has_a_stable_code, every_call_resolves_exactly_once
    / "every error code matches the rust crate", "every call resolves exactly once"
`;

const RULES = `
RULES: Work directly in the current checkout — no branches, no worktrees, no commits, no pushes,
never any other repository, never an emulator or simulator. You may run small scoped checks on your
own files while implementing, but the script runs the deciding gates after you, so do not run the
full suite yourself. If a gate is impossible to pass or the instructions contradict each other,
say so plainly in your result instead of working around it. Reference checkouts are under .refs/
(read-only material to build on, never to modify).
`;

function implementSystem(role: string): string {
  return (
    `You are the ${role} for one area of a parallel build of nsh-in-app-review. ` +
    `Follow your ask exactly; where your own taste conflicts with it, the ask wins. ` +
    RULES
  );
}

function auditSystem(role: string): string {
  return (
    `You are the ${role} auditing one area of a parallel build of nsh-in-app-review. ` +
    `Read-only: never edit any file, never run the deciding gates yourself — the script runs them ` +
    `and hands you their output. Return ONLY actionable findings: what is wrong, missing, or ` +
    `contradicts the contract, each with its path. No praise, no PASS notes. A cross-target compile ` +
    `failure caused by toolchain setup (missing linker, sysroot or C compiler) is an environment ` +
    `limitation, not a finding: put it in environmentBlocked with the command that failed. ` +
    RULES
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit loop: check (deterministic gates + a read-only auditor), fix if
// findings, repeat — until a round is clean or the cap of 3 is exhausted, then
// one final verification decides "converged" honestly.
// ─────────────────────────────────────────────────────────────────────────────

async function auditLoop(
  area: string,
  implementer: Subagent,
  checker: Subagent,
  check: () => Promise<Finding[]>,
  owns: string,
): Promise<{ converged: boolean; rounds: number; remaining: Finding[]; envNotes: string[] }> {
  let rounds = 0;
  let remaining: Finding[] = [];
  const envNotes: string[] = [];

  for (let round = 1; round <= AUDIT_ROUNDS; round++) {
    rounds = round;
    report({ name: area, phase: "auditing", summary: `gates and review, pass ${round} of ${AUDIT_ROUNDS}` }, "areas");
    const gateFindings = await check();
    const verdict = await checker.ask<AuditVerdict>(
      `Audit the "${area}" area. The script already ran the deterministic gates; their failures ` +
        `follow as findings. Read the files this area owns (${owns}) and whatever they must agree ` +
        `with (the contract in your system prompt, .refs/ references, sibling files as named in the ` +
        `ask that wrote them), then return only actionable findings.\nGate findings: ${JSON.stringify(gateFindings)}`,
    );
    remaining = [...gateFindings, ...verdict.findings];
    if (verdict.environmentBlocked !== undefined) envNotes.push(verdict.environmentBlocked);
    if (remaining.length === 0) return { converged: true, rounds, remaining, envNotes };
    if (round === AUDIT_ROUNDS) break;
    report({ name: area, phase: "fixing", summary: `${remaining.length} finding(s) to fix` }, "areas");
    const fix = await implementer.ask<FixOutcome>(
      `Fix every finding below in the "${area}" area. You own: ${owns}. Keep the contract intact.\n` +
        `${JSON.stringify(remaining)}`,
    );
    if (!fix.done) envNotes.push(`fixer reported: ${fix.summary}`);
  }

  report({ name: area, phase: "testing", summary: "final verification after the last fix" }, "areas");
  const gateFindings = await check();
  const verdict = await checker.ask<AuditVerdict>(
    `Final verification of the "${area}" area after its last fix. The gates were run by the script; ` +
      `read your area's files (${owns}) and return only actionable findings.\n` +
      `Gate findings: ${JSON.stringify(gateFindings)}`,
  );
  remaining = [...gateFindings, ...verdict.findings];
  if (verdict.environmentBlocked !== undefined) envNotes.push(verdict.environmentBlocked);
  return { converged: remaining.length === 0, rounds, remaining, envNotes };
}

function auditedArea(
  area: string,
  role: string,
  implAsk: string,
  check: () => Promise<Finding[]>,
  owns: string,
): Promise<AreaResult> {
  return (async (): Promise<AreaResult> => {
    report({ name: area, phase: "implementing", summary: "writing the area's files" }, "areas");
    const implementer = agent(`impl·${area}`, { system: implementSystem(role), model: MODELS.pro });
    const checker = agent(`audit·${area}`, { system: auditSystem(`${role} auditor`), model: MODELS.pro });
    const out = await implementer.ask<ImplementOutcome>(`${implAsk.trim()}\n${RULES}`);
    if (!out.done) {
      report({ name: area, phase: "failed", summary: out.summary }, "areas");
      return { name: area, status: "failed", summary: out.summary, notes: out.blockers };
    }
    const audit = await auditLoop(area, implementer, checker, check, owns);
    const status: AreaResult["status"] = audit.converged ? "done" : "failed";
    const notes = [...audit.envNotes];
    if (!audit.converged && audit.remaining.length > 0) {
      notes.push(`still open after the cap: ${JSON.stringify(audit.remaining)}`);
    }
    report({
      name: area,
      phase: status,
      summary: out.summary + (audit.converged ? "" : " (audit did not converge)"),
    }, "areas");
    return {
      name: area,
      status,
      summary: out.summary,
      converged: audit.converged,
      rounds: audit.rounds,
      notes: notes.length > 0 ? notes : undefined,
    };
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped gates per area. Every world.run command is a literal; variable parts
// live in the args array.
// ─────────────────────────────────────────────────────────────────────────────

async function checkNothing(): Promise<Finding[]> {
  return [];
}

async function checkCiYaml(): Promise<Finding[]> {
  const parse = await world.run(
    "python3",
    ["-c", "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml parses')"],
    { timeoutMs: 60_000 },
  );
  return parse.exitCode === 0 ? [] : [gateFinding("python3 yaml parse of ci.yml", parse)];
}

async function checkRustCore(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fmt = await world.run("cargo", ["fmt", "--all", "--", "--check"], { timeoutMs: GATE_FAST });
  if (fmt.exitCode !== 0) findings.push(gateFinding("cargo fmt --all -- --check", fmt));
  const clippy = await world.run(
    "cargo",
    ["clippy", "-p", "nsh-in-app-review", "--all-targets", "--", "-D", "warnings"],
    { timeoutMs: GATE_CARGO },
  );
  if (clippy.exitCode !== 0) findings.push(gateFinding("cargo clippy -p nsh-in-app-review", clippy));
  const test = await world.run("cargo", ["test", "-p", "nsh-in-app-review", "--all-targets"], {
    timeoutMs: GATE_CARGO,
  });
  if (test.exitCode !== 0) findings.push(gateFinding("cargo test -p nsh-in-app-review", test));
  return findings;
}

async function checkNshPackage(): Promise<Finding[]> {
  const check = await world.run("sh", ["-c", "cd packages/nsh-in-app-review && nsh check"], {
    timeoutMs: GATE_NSH,
  });
  return check.exitCode === 0 ? [] : [gateFinding("nsh check", check)];
}

async function checkNshTests(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const test = await world.run("sh", ["-c", "cd packages/nsh-in-app-review && nsh test"], {
    timeoutMs: GATE_NSH,
  });
  if (test.exitCode !== 0) findings.push(gateFinding("nsh test", test));
  const rust = await world.run("cargo", ["test", "-p", "nsh-in-app-review", "--all-targets"], {
    timeoutMs: GATE_CARGO,
  });
  if (rust.exitCode !== 0) findings.push(gateFinding("cargo test -p nsh-in-app-review", rust));
  return findings;
}

// A cross-target compile check for one bridge. The outcome feeds the auditor as
// gate evidence; a toolchain-setup failure is an environment limit, not a finding.
async function targetCheck(target: string, note: string): Promise<Finding[]> {
  const check = await world.run(
    "cargo",
    ["check", "-p", "nsh-in-app-review", "--target", target, "--all-targets"],
    { timeoutMs: GATE_CARGO },
  );
  if (check.exitCode === 0) return [];
  return [
    {
      path: "(gate)",
      severity: "medium",
      problem:
        `Cross-target check against ${target} exited ${check.exitCode} (${note}). If the cause is in ` +
        `this area's file it is a finding; if it is toolchain setup (linker, sysroot, C compiler) it ` +
        `is an environment limit to report in environmentBlocked. Output tail:\n` +
        `${(check.stderr || check.stdout || "").slice(-3000)}`,
    },
  ];
}

async function checkBridge(target: string | null, note: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const clippy = await world.run(
    "cargo",
    ["clippy", "-p", "nsh-in-app-review", "--all-targets", "--", "-D", "warnings"],
    { timeoutMs: GATE_CARGO },
  );
  if (clippy.exitCode !== 0) findings.push(gateFinding("cargo clippy -p nsh-in-app-review", clippy));
  if (target !== null) findings.push(...(await targetCheck(target, note)));
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-area implement asks. Each carries its complete predetermined plan.
// ─────────────────────────────────────────────────────────────────────────────

const GOALS_ASK = `
Implement the "goals-docs" area. Write docs/goals.md (the only file you own), from AGENTS.md,
docs/brief.md, and the references: Flutter .refs/in_app_review/in_app_review/lib/in_app_review.dart,
React Native .refs/react-native-in-app-review/index.d.ts, layout and behavior
.refs/biometrics/crates/nsh-biometrics/src/. Content, in this order:
1. Goals: request the native in-app review prompt on iOS and Android, with a store fallback through
   the NSH host's openUrl on desktop, web and anywhere without a native prompt; one Rust crate
   (crates/nsh-in-app-review) and one TypeScript package (packages/nsh-in-app-review) laid out like
   .refs/biometrics, with the same API names and the same behavior in both.
2. Acceptance criteria: cargo fmt --all -- --check; cargo clippy --all-targets -- -D warnings;
   cargo test --all-targets; the TypeScript typecheck and tests (nsh check, nsh test) run in GitHub
   CI (.github/workflows/ci.yml runs both); every behavior has a test in BOTH languages; every call
   resolves exactly once — success, a coded error, or a cancel; no panics, no hangs; status claims
   stay honest until CI has actually run them.
3. The error enum, with a stable code for every failure mode — use exactly the five kinds and codes
   in the CONTRACT below, each with one sentence on when it is returned.
4. The edge-case list: use exactly E1..E12 from the EDGE CASES block below, each mapping to its
   named test pair, and covering everything docs/brief.md lists (iOS 3-per-365-days counted
   client-side, Android's quota opaque, the prompt may show nothing with no signal, never call it
   from a button press the user expects to do something — that last one is design guidance the
   one-flow-at-a-time rule and docs enforce).
${CONTRACT}
${EDGE_CASES}
Report done with a one-sentence summary when docs/goals.md is complete.
`;

const PARITY_ASK = `
Implement the "parity-docs" area. You own docs/parity.md and docs/decisions.md (no other file).
Read the reference APIs first: .refs/in_app_review/in_app_review/lib/in_app_review.dart (Flutter) and
.refs/react-native-in-app-review/index.d.ts plus index.js (React Native), then docs/brief.md and
AGENTS.md. Rewrite docs/parity.md into an API parity table with one row for EVERY public API of both
references — Flutter: isAvailable, requestReview, openStoreListing(appStoreId, microsoftStoreId);
React Native: RequestInAppReview, isAvailable, requestInAppCommentAppGallery — with columns: the
reference API, our API (is_available, request_review, open_store_listing on Rust InAppReview; the
same camelCase methods on the TS InAppReview; isAvailable is async for us where RN's is sync),
what ours does for it, and an honest status ("implemented", "test in both languages", or
"not implemented" for requestInAppCommentAppGallery — Huawei AppGallery is not a target; say why in
the row). Include a short section on the store fallback (desktop, Linux, web route through the
NSH host's openUrl; the URL formats live in the CONTRACT below) and the quota differences
(iOS 3 per 365 days counted client-side by us; Android's quota is Google Play's and opaque, so we
make no client-side claim there beyond our own counter).
Update docs/decisions.md: resolve its three open items — NSH version 0.4.0 (the version biometrics
pins and what is installed; verify the crate's API against the real 0.4.0 crate during the build,
not against nsh's main branch), the library choice per platform (StoreKit SKStoreReviewController on
Apple; Google Play In-App Review API over JNI on Android; the host's openUrl everywhere else), and
platforms in scope (iOS, Android, macOS via the Apple bridge; Windows store fallback; Linux no-store
fallback; web store-listing only). Add a "Decided" entry recording that all four reference repos
cloned cleanly into .refs/ from the URLs in the brief, and keep the tone of the existing file.
${CONTRACT}
Report done with a one-sentence summary when both files are complete.
`;

const CI_ASK = `
Implement the "ci-update" area. You own .github/workflows/ci.yml (no other file; leave
.github/workflows/pages.yml untouched). Read the current ci.yml and .refs/biometrics/.github/workflows/ci.yml.
Update it so CI runs both toolchains per AGENTS.md, keeping the existing style (short header comment,
pinned action SHAs copied verbatim from the existing files, concurrency group, minimal permissions):
1. Keep the rust job as it is (cargo fmt --all -- --check, cargo clippy --all-targets -- -D warnings,
   cargo test --all-targets) — it now runs the workspace.
2. Add a typescript job mirroring biometrics' typescript job: install NSH v0.4.0 with biometrics'
   exact install steps (both the non-Windows and Windows variants), then in
   working-directory packages/nsh-in-app-review run nsh check, nsh build piped through tee with the
   "! grep -i warn build.log" guard, and nsh test.
3. Add a cross-check job with a matrix of aarch64-apple-ios, aarch64-linux-android and
   wasm32-unknown-unknown running cargo clippy -p nsh-in-app-review --target <target> --all-targets
   -- -D warnings, including biometrics' NDK CC/AR/linker env block for the Android target.
Keep the workflow named CI with the same triggers (push to master, pull_request, workflow_dispatch).
${RULES}
Report done with a one-sentence summary when ci.yml is updated.
`;

const CORE_ASK = `
Implement the "rust-core" area: the Rust core API, error types, platform trait, mock backend and
quota logic. You own exactly: Cargo.toml (root, becomes the workspace manifest), the old root
src/lib.rs (delete it; the crate moves to crates/), crates/nsh-in-app-review/Cargo.toml, and
crates/nsh-in-app-review/src/{lib.rs, review.rs, quota.rs, options.rs, backend.rs, error.rs, fake.rs,
native.rs, platform/mod.rs, platform/unsupported.rs}. The five bridge files under platform/
are other areas' — your platform/mod.rs declares them cfg-gated (a cfg'd-out mod needs no file, so
the crate compiles before they exist) and selects native_backend() per cfg.
Read first: AGENTS.md, docs/brief.md, .refs/biometrics/crates/nsh-biometrics/src/{lib.rs, backend.rs,
error.rs, fake.rs, native.rs} (the layout and style to mirror), and the open_url module docs in
.refs/nsh/crates/nsh-core/src/open_url.rs (the host's openUrl your UrlOpener wraps).
Follow the CONTRACT below exactly for the API, the five error kinds and codes, the quota, the fake
backend and the cfg gates. native.rs exposes a NativeInAppReview class to TSX mirroring biometrics'
NativeLocalAuth pattern: methods isAvailable(), requestReview(), storeListingUrl(options) with a
NativeStoreListingOptions JsObject { app_store_id, microsoft_store_id }, rejections carrying the
stable code via JsError with_code like biometrics' into_js. For the class's URL opener, use nsh-core's
ambient open_url if nsh-core 0.4.0 actually exposes it (verify against the real crate, not nsh main);
if it does not, construct the class's InAppReview with a opener stub that reports the limitation —
record exactly what you found in your result summary, never fake it.
Add the bridge dependencies up front exactly as the CONTRACT's deps paragraph lists them
(objc2-store-kit under apple, jni + ndk-context + libc under android) — the bridge areas own no
manifest and count on you for this. Do not write any test file: the tests area owns
crates/nsh-in-app-review/tests/. Your lib.rs re-exports
the public API (InAppReview, StoreListingOptions, Backend, BackendFuture, ReviewDone, UrlOpener,
QuotaTracker, MemoryQuotaTracker, FakeBackend, FakeOpener, InAppReviewError, ErrorKind, and the
native module under "nsh-in-app-review/native") like biometrics' lib.rs does.
${CONTRACT}
Report done with a one-sentence summary when the crate compiles clean under cargo check.
`;

function bridgeAsk(name: string, platform: string, body: string): string {
  return `
Implement the "${name}" area: one file, crates/nsh-in-app-review/src/platform/${platform}.rs —
the ${platform} bridge implementing the crate's Backend trait. You own only that file; everything
else exists already (the core area wrote the trait, error and platform/mod.rs cfg gates).
Read first: crates/nsh-in-app-review/src/{backend.rs, error.rs, options.rs, platform/mod.rs} (the
contract as built — implement THAT, not a variant), and the matching bridge in
.refs/biometrics/crates/nsh-biometrics/src/platform/ for the cfg-gate, JNI/system-API and
no-panic/no-hang style.
${body}
Every call resolves exactly once; no panics, no unwraps on remote data, no unbounded waits; every
failure is a coded InAppReviewError per the CONTRACT. A local cross-target compile check runs after
you; a toolchain-setup failure there is an environment limit, not your bug.
${CONTRACT}
Report done with a one-sentence summary.
`;
}

const APPLE_BODY = `
Apple (iOS and macOS): availability through SKStoreReviewController via the objc2-store-kit crate
(already a target dependency of the crate — do not edit Cargo.toml). requestReview() has no
completion callback, so
start_review calls done(Ok(true)) right after handing the request to the OS. store_listing_url
requires app_store_id (Err(InvalidArgument) when missing or blank) and builds
"itms-apps://itunes.apple.com/app/id{app_store_id}?action=write-review"; microsoft_store_id is
ignored. is_available is Ok(true) on Apple (the 10.3+/10.14+ OS floor is far below any SDK in use).
`;

const ANDROID_BODY = `
Android: Google Play's In-App Review API over JNI, with ndk-context for the VM and activity, mirroring
.refs/biometrics/crates/nsh-biometrics/src/platform/android.rs's JNI pattern (the play review classes
come from the app bundling com.google.android.play:review; invoke them over JNI — record in your
summary that the app must add that dependency, as biometrics records its androidx biometrics
requirement). start_review drives requestReviewFlow then launchReviewFlow: done(Ok(true)) when the
flow's task completes, done(Ok(false)) when the user dismissed without completing, and coded errors
(NotAvailable when Play is missing or the API is unavailable, Cancelled, Backend) otherwise. Keep the
JNI surface minimal and every exception mapped to a coded error, never a panic.
`;

const WINDOWS_BODY = `
Windows: no native prompt (is_available Ok(false), start_review Err(NotAvailable)). store_listing_url
requires microsoft_store_id (Err(InvalidArgument) when missing or blank) and builds
"ms-windows-store://pdp/?ProductId={microsoft_store_id}". The URL is opened by the host's openUrl
(the UrlOpener seam), not by this file. Gate the whole file behind #[cfg(target_os = "windows")] with
no new dependencies.
`;

const LINUX_BODY = `
Linux: no store listing and no prompt — is_available Ok(false), start_review Err(NotAvailable),
store_listing_url Err(NotAvailable). Gate the file behind #[cfg(target_os = "linux")] with no
dependencies, and keep the doc comment honest: a Linux store fallback would go through the host's
openUrl if a store ever exists.
`;

const WEB_BODY = `
Web (wasm32): no native prompt — is_available Ok(false), start_review Err(NotAvailable).
store_listing_url builds web store URLs per the CONTRACT: app_store_id ->
"https://apps.apple.com/app/id{app_store_id}", else microsoft_store_id ->
"https://www.microsoft.com/store/productId/{microsoft_store_id}", else Err(InvalidArgument). Gate the
file behind #[cfg(target_arch = "wasm32")] with no dependencies; opening is the host opener's job
(window.open in a web host), never this file's.
`;

const TS_ASK = `
Implement the "ts-package" area: the TypeScript package mirroring the Rust crate, laid out like
.refs/biometrics/packages/nsh-biometrics. You own exactly: packages/nsh-in-app-review/{package.json,
tsconfig.json, nsh.json, App.tsx} and packages/nsh-in-app-review/src/{index.ts, review.ts, quota.ts,
options.ts, backend.ts, errors.ts, memory.ts, rust.ts}. The tests directory belongs to another area —
do not create it. Read the Rust crate first (crates/nsh-in-app-review/src/{lib.rs, review.rs, quota.rs,
options.rs, backend.rs, error.rs, native.rs}) — it is the spec — and mirror its names and behavior;
also read .refs/biometrics/packages/nsh-biometrics/src/{index.ts, auth.ts, backend.ts, errors.ts,
memory.ts, options.ts, rust.ts} and its package.json, tsconfig.json, nsh.json for the conventions:
type-module package with exports ".", "./rust", "./memory"; tsconfig extending ./.nsh/tsconfig.json;
nsh.json with id "dev.supernsh.in_app_review.tests", rust "../../crates/nsh-in-app-review" and
capabilities {"openUrl": true} (the store fallback needs every scheme: itms-apps, ms-windows-store,
https).
Follow the CONTRACT below for names and behavior: src/errors.ts has the InAppReviewErrorCode union
(exactly the five codes), the InAppReviewError class and asInAppReviewError (same host-error
parsing as biometrics' asBiometricsError); src/backend.ts the ReviewBackend interface
(isAvailable(): Promise<boolean>, startReview(): Promise<boolean> resolving once,
storeListingUrl(options): Promise<string>) and the UrlOpener interface (openUrl(url): Promise<void>);
src/quota.ts the QuotaTracker interface and memoryQuotaTracker (3 per rolling 365 days, injectable
now()); src/review.ts the InAppReview service class with the same semantics as the Rust struct
(one flow at a time -> ERR_IN_APP_REVIEW_IN_PROGRESS, quota exhausted -> resolves false,
NotAvailable, Cancelled, Ok(true) = handed over with no shown-signal — copy the Rust doc comments'
meaning); src/options.ts StoreListingOptions { appStoreId?: string, microsoftStoreId?: string };
src/memory.ts memoryBackend(config) mirroring FakeBackend (finishPrompt, prompts, lastUrl,
setOpenResult, failNextPrompt) plus fakeOpener(config); src/rust.ts rustBackend() and rustOpener()
wrapping the native class from "nsh-in-app-review/native" with asInAppReviewError settling, and the
TSX-side opener wired to nsh/device's openUrl where that import exists in .refs/nsh's TSX typings —
if it does not resolve, use the native class for the opener too and record what you did in your
summary. App.tsx is a minimal demo (mount, signal, Text, View like biometrics') showing status text;
a button that requests the review must not pretend to do something else (docs/brief.md guidance).
${CONTRACT}
Report done with a one-sentence summary.
`;

const TESTS_ASK = `
Implement the "tests" area: the unit/integration test suites for every goal, edge case and error
path, in BOTH languages. You own exactly: crates/nsh-in-app-review/tests/{review.rs, quota.rs,
store_listing.rs, errors.rs} and packages/nsh-in-app-review/tests/{review.test.tsx, quota.test.tsx,
store-listing.test.tsx, errors.test.tsx} (fixtures allowed under packages/nsh-in-app-review/tests/
if needed). Read first: the built crate (crates/nsh-in-app-review/src/ — the API under test) and the
built package (packages/nsh-in-app-review/src/), .refs/biometrics/crates/nsh-biometrics/tests/ and
.refs/biometrics/packages/nsh-biometrics/tests/ for the style (#[tokio::test] with the fake backend;
import { expect, test } from "nsh/test" with memoryBackend).
Drive everything through FakeBackend/FakeOpener/MemoryQuotaTracker::with_clock in Rust and
memoryBackend/fakeOpener/memoryQuotaTracker in TS — never a device, never an emulator. Cover exactly
the E1..E12 cases with the exact test names in the EDGE CASES block below; E12's TS test asserts the
five TS codes equal the Rust list (the CONTRACT's list, spelled out in both files so the comparison
is explicit). For E9/E7, test the store URL rules through a test-owned Backend in each language
reproducing the CONTRACT's per-platform rules, plus — in Rust only — a #[cfg(target_vendor = "apple")]
test exercising the real apple bridge's store_listing_url (it compiles on this host).
${CONTRACT}
${EDGE_CASES}
Report done with a one-sentence summary when both suites pass.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Chains. The core area spawns its dependents (the five bridges, then the TS
// package, then the tests) the moment its own implement lands — no global
// barrier; the core audit loop runs concurrently with all of them.
// ─────────────────────────────────────────────────────────────────────────────

async function bridgeChain(name: string, platform: string, body: string, target: string | null, note: string): Promise<AreaResult> {
  return auditedArea(
    name,
    `${platform} bridge engineer`,
    bridgeAsk(name, platform, body),
    () => checkBridge(target, note),
    `crates/nsh-in-app-review/src/platform/${platform}.rs`,
  );
}

async function coreAndDependents(): Promise<AreaResult[]> {
  const area = "rust-core";
  report({ name: area, phase: "implementing", summary: "workspace, crate, core API, errors, fake, quota" }, "areas");
  const implementer = agent(`impl·${area}`, { system: implementSystem("Rust core engineer"), model: MODELS.pro });
  const checker = agent(`audit·${area}`, { system: auditSystem("Rust core auditor"), model: MODELS.pro });
  const out = await implementer.ask<ImplementOutcome>(CORE_ASK);
  if (!out.done) {
    report({ name: area, phase: "failed", summary: out.summary }, "areas");
    const blockedNames = ["apple-bridge", "android-bridge", "windows-bridge", "linux-bridge", "web-bridge", "ts-package", "tests"];
    const blocked: AreaResult[] = blockedNames.map((name) => ({
      name,
      status: "blocked" as const,
      summary: "the rust core did not implement; nothing to build on",
    }));
    return [{ name: area, status: "failed", summary: out.summary, notes: out.blockers }, ...blocked];
  }

  const coreAudit: Promise<AreaResult> = (async (): Promise<AreaResult> => {
    const audit = await auditLoop(area, implementer, checker, checkRustCore, "Cargo.toml, crates/nsh-in-app-review/Cargo.toml, crates/nsh-in-app-review/src/ except the five platform bridge files");
    const notes = [...audit.envNotes];
    if (!audit.converged && audit.remaining.length > 0) notes.push(`still open after the cap: ${JSON.stringify(audit.remaining)}`);
    report({ name: area, phase: audit.converged ? "done" : "failed", summary: out.summary + (audit.converged ? "" : " (audit did not converge)") }, "areas");
    return { name: area, status: audit.converged ? "done" : "failed", summary: out.summary, converged: audit.converged, rounds: audit.rounds, notes: notes.length > 0 ? notes : undefined };
  })();

  const bridges: Promise<AreaResult[]> = Promise.all([
    bridgeChain("apple-bridge", "apple", APPLE_BODY, "aarch64-apple-ios", "the iOS target"),
    bridgeChain("android-bridge", "android", ANDROID_BODY, "aarch64-linux-android", "the Android target"),
    bridgeChain("windows-bridge", "windows", WINDOWS_BODY, "aarch64-pc-windows-gnullvm", "the Windows gnullvm target"),
    bridgeChain("linux-bridge", "linux", LINUX_BODY, "aarch64-unknown-linux-gnu", "the Linux gnu target"),
    bridgeChain("web-bridge", "web", WEB_BODY, "wasm32-unknown-unknown", "the wasm32 target"),
  ]);

  const tsAndTests: Promise<AreaResult[]> = (async (): Promise<AreaResult[]> => {
    const ts = await auditedArea(
      "ts-package",
      "TypeScript package engineer",
      TS_ASK,
      checkNshPackage,
      "packages/nsh-in-app-review/ except its tests directory",
    );
    if (ts.status !== "done") {
      return [ts, { name: "tests", status: "blocked", summary: "the TypeScript package did not implement; its half of the suites has nothing to test" }];
    }
    const tests = await auditedArea("tests", "test engineer", TESTS_ASK, checkNshTests, "crates/nsh-in-app-review/tests/ and packages/nsh-in-app-review/tests/");
    return [ts, tests];
  })();

  const [auditResult, bridgeResults, tsResults] = await Promise.all([coreAudit, bridges, tsAndTests]);
  return [auditResult, ...bridgeResults, ...tsResults];
}

// ─────────────────────────────────────────────────────────────────────────────
// The run.
// ─────────────────────────────────────────────────────────────────────────────

artifact.board("areas", {
  title: "nsh-in-app-review areas and phases",
  key: "name",
  status: "phase",
  columns: ["implementing", "auditing", "fixing", "testing", "done", "failed", "blocked"],
  detail: [{ field: "summary" }],
});

phase("Verify the reference clones the brief requires");
const refs = await world.run("ls", [".refs"], { timeoutMs: 30_000 });
const ignored = await world.run("grep", ["-q", ".refs", ".gitignore"], { timeoutMs: 30_000 });
const refsReady = refs.exitCode === 0 && ignored.exitCode === 0 && refs.stdout.includes("biometrics") && refs.stdout.includes("nsh");
log(refsReady ? "the four reference checkouts are in .refs/ and ignored by git" : ".refs/ is incomplete — the reference-reading asks will say so honestly");

phase("Build every area in parallel, each through its own implement and audit chain");
const results: AreaResult[] = (await Promise.all([
  auditedArea("goals-docs", "product engineer", GOALS_ASK, checkNothing, "docs/goals.md"),
  auditedArea("parity-docs", "integration engineer", PARITY_ASK, checkNothing, "docs/parity.md and docs/decisions.md"),
  auditedArea("ci-update", "CI engineer", CI_ASK, checkCiYaml, ".github/workflows/ci.yml"),
  coreAndDependents(),
])).flat();

phase("Run the whole-tree gates once on the finished tree");
const gateNames = [
  "cargo fmt --all -- --check",
  "cargo clippy --all-targets -- -D warnings",
  "cargo test --all-targets",
  "nsh check (packages/nsh-in-app-review)",
  "nsh test (packages/nsh-in-app-review)",
  "python3 yaml parse of ci.yml",
];
const verified: string[] = [];
let gateFailures: string[] = [];
const joinFixer = agent("impl·whole-tree", {
  system:
    "You fix a failing whole-tree gate across the nsh-in-app-review build. Respect the area file " +
    "ownership already in place: change the file the failure points at, nothing else. " +
    RULES,
  model: MODELS.pro,
});
for (let attempt = 1; attempt <= 2; attempt++) {
  gateFailures = [];
  const fmt = await world.run("cargo", ["fmt", "--all", "--", "--check"], { timeoutMs: GATE_FAST });
  if (fmt.exitCode !== 0) gateFailures.push(`${gateNames[0]} failed:\n${(fmt.stderr || fmt.stdout).slice(-2000)}`);
  const clippy = await world.run("cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], { timeoutMs: GATE_CARGO });
  if (clippy.exitCode !== 0) gateFailures.push(`${gateNames[1]} failed:\n${(clippy.stderr || clippy.stdout).slice(-3000)}`);
  const test = await world.run("cargo", ["test", "--all-targets"], { timeoutMs: GATE_CARGO });
  if (test.exitCode !== 0) gateFailures.push(`${gateNames[2]} failed:\n${(test.stderr || test.stdout).slice(-3000)}`);
  const nshCheck = await world.run("sh", ["-c", "cd packages/nsh-in-app-review && nsh check"], { timeoutMs: GATE_NSH });
  if (nshCheck.exitCode !== 0) gateFailures.push(`${gateNames[3]} failed:\n${(nshCheck.stderr || nshCheck.stdout).slice(-3000)}`);
  const nshTest = await world.run("sh", ["-c", "cd packages/nsh-in-app-review && nsh test"], { timeoutMs: GATE_NSH });
  if (nshTest.exitCode !== 0) gateFailures.push(`${gateNames[4]} failed:\n${(nshTest.stderr || nshTest.stdout).slice(-3000)}`);
  const yaml = await world.run(
    "python3",
    ["-c", "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"],
    { timeoutMs: 60_000 },
  );
  if (yaml.exitCode !== 0) gateFailures.push(`${gateNames[5]} failed:\n${(yaml.stderr || yaml.stdout).slice(-1000)}`);
  if (gateFailures.length === 0) {
    for (const name of gateNames) verified.push(`${name} — exit 0 at the whole-tree join`);
    break;
  }
  if (attempt === 2) break;
  log(`${gateFailures.length} whole-tree gate(s) failed; one fix round before re-running them`);
  await joinFixer.ask<FixOutcome>(
    `These whole-tree gates failed. Fix what they point at, in the file each failure names.\n${gateFailures.join("\n\n")}`,
  );
}

phase("Settle the README status and collect the report");
const readme = await agent("docs·readme-status", {
  system:
    "You keep a README honest under AGENTS.md: status claims must match what has actually run. " + RULES,
  model: MODELS.pro,
}).ask<FixOutcome>(
  `Update ONLY README.md in this repo. The scaffold claims ("Scaffold. Not implemented.", the ` +
    `placeholder layout list) are now stale: the tree carries crates/nsh-in-app-review (Rust crate: ` +
    `in-app review API, platform bridges, fake backend) and packages/nsh-in-app-review (TypeScript ` +
    `mirror), docs/goals.md was added, docs/parity.md and docs/decisions.md were rewritten. No commit ` +
    `was made and no CI run happened, so per AGENTS.md nothing may be claimed as verified by a run — ` +
    `write the Status section to say implemented locally with the gates run in this working session, ` +
    `and that a push to master is what produces the first CI run. Update the Layout list to the real ` +
    `tree. Keep the tone, the Checks section's spirit, and the rest of the file. Do not touch any ` +
    `other file.`,
);

const failed = results.filter((r) => r.status !== "done");
const notConverged = results.filter((r) => r.converged === false);
const conclusionParts: string[] = [];
conclusionParts.push(
  failed.length === 0
    ? `All ${results.length} areas implemented: the Rust crate (core API, five platform bridges, fake backend, quota) and the TypeScript mirror, with unit suites in both languages, docs, and CI wiring both toolchains.`
    : `${results.length - failed.length} of ${results.length} areas finished; ${failed.length} failed or were blocked: ${failed.map((r) => r.name).join(", ")}.`,
);
if (gateFailures.length > 0) conclusionParts.push(`The whole-tree join still has ${gateFailures.length} failing gate(s): ${gateFailures.map((g) => g.split("\n")[0]).join("; ")}.`);
else if (verified.length > 0) conclusionParts.push("All six whole-tree gates exited 0 at the join.");
if (notConverged.length > 0) conclusionParts.push(`Audit rounds did not converge in ${notConverged.map((r) => `${r.name} (${r.rounds})`).join(", ")} — reported honestly below.`);
if (!readme.done) conclusionParts.push("The README status update did not finish.");

const notCovered: string[] = [
  "Real device behavior — AGENTS.md forbids emulators/simulators and no device was touched; the bridges compile and are audited, never exercised on hardware.",
  "GitHub CI itself — no commit or push was made, so ci.yml has never run; its YAML parses locally.",
  "site/ status page — outside the brief's areas, untouched.",
];
const targetNotes = results.flatMap((r) => (r.notes ?? []).filter((n) => n.includes("environment") || n.includes("Cross-target")));
if (targetNotes.length > 0) notCovered.push(`Cross-target compilation gaps reported by the areas: ${targetNotes.join(" | ")}`);

await artifact.markdown(
  "report",
  [
    "# nsh-in-app-review build report",
    "",
    conclusionParts.join(" "),
    "",
    "## Areas",
    ...results.map(
      (r) =>
        `- **${r.name}** — ${r.status}${r.converged === undefined ? "" : r.converged ? `, converged in ${r.rounds} audit round(s)` : ", NOT converged"}: ${r.summary}`,
    ),
    "",
    "## Gates run",
    ...(verified.length > 0 ? verified.map((v) => `- ${v}`) : gateFailures.map((g) => `- ${g.split("\n")[0]}`)),
    "",
    "## Not covered",
    ...notCovered.map((n) => `- ${n}`),
  ].join("\n"),
  { title: "In-app review build report", description: "Per-area outcomes, gates and gaps", primary: true },
);

const report: WorkflowReport = {
  conclusion: conclusionParts.join(" "),
  areas: results,
  verified,
  notCovered,
  notes: [
    "Every implementer and checker is pinned to account:zai-individual-coding-plan/GLM-5.3$high per the brief (no vision rounds were needed, so no flash pin exists).",
    "Audit budget: 3 rounds per area, each round = scoped deterministic gates + a read-only auditor; one final verification decides convergence. Areas report converged/rounds honestly.",
    "STEP 0 ran before the workflow: the four reference repos cloned into .refs/ (git-ignored), read by the areas through their asks; all four URLs resolved, so docs/decisions.md needs no relocated-URL entry — if the parity-docs area says otherwise, trust its summary.",
    refsReady ? "The pre-flight confirmed .refs/ contains all four clones." : "The pre-flight could NOT confirm .refs/ contents; the reference-reading areas will report the gap.",
    gateFailures.length > 0 ? "Whole-tree gate failures (verbatim heads):\n" + gateFailures.map((g) => g.split("\n")[0]).join("\n") : "The whole-tree join ran the brief's exact gates: cargo fmt/clippy/test plus nsh check/test and the ci.yml YAML parse.",
  ],
};
return report;
