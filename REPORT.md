# Design write-up

A system that uses an LLM to learn a flow through a legacy application once, freezes what it
learned into a typed, reviewable capability artifact, and then replays that artifact
deterministically — with no model in the decision loop — returning a structured result that
distinguishes business answers from recoverable conditions from real failures, and pulling a
human into the live session when it cannot safely proceed.

Target surface: a purpose-built stand-in, `MemberLink Core Servicing` — a frameset-based,
table-layout, no-test-ID back-office app with two tenants running the same vendor product under
different branding, and switchable runtime faults. Why I built the target rather than using a
public demo site is in **Cuts**.

---

## Architecture

```
 capability spec (authored)          ┌──────────────────────────────────────────┐
   contract + app profile   ───────► │ DISCOVERY   agent/loop.ts                │
                                     │ observe → decide → act, Claude Opus 5    │
                                     │ 2 phases: happy path, then one probe run │
                                     └───────────────┬──────────────────────────┘
                                                     │ Recorder
                                                     ▼
                                       capabilities/<id>@<ver>.json   ← reviewed, versioned
                                                     │
                                     ┌───────────────▼──────────────────────────┐
  agent calls by name ─────────────► │ REPLAY      replay/engine.ts             │
                                     │ no model. resolve → act → verify         │
                                     └───────────────┬──────────────────────────┘
                                                     ▼
                                       ReplayResult: success | business_outcome | failure

 shared spine:  Surface (perceive/act)   Policy (allowlist, risk, redaction)
                RunLogger (evidence)     SessionController + EscalationBroker (handoff)
```

Single process, TypeScript, Playwright, Zod. No queue, no services, no database — the brief
explicitly does not reward scaling infrastructure, and every boundary that would become a
service boundary later is already a module boundary with a typed interface today
(`Surface`, `SessionControl`, `EscalationBroker`, `CapabilityStore`).

**The four decisions that shaped everything else.**

**1. Perception is accessibility-first; action is control-addressed.** The model never sees HTML
and never writes a selector. Each turn it gets an accessibility snapshot per frame plus a
*control inventory* (`src/surface/inventory.ts`) and addresses controls by an ephemeral `ref`.
The perception layer — not the model — computes the ranked locator strategies that get recorded.
This removes the classic failure of LLM recording: a plausible selector invented by something
that cannot see next month's markup. It is also why the accessibility bias pays off twice, since
the same representation exists on desktop.

I did not use pure screenshot+coordinates. Coordinates are fine for discovery and hopeless for
replay: they are not stable across window size, font stack or scroll position, and this system's
entire value is in the replay path. The compromise is deliberate — perceive like a computer-use
agent, act on addressable controls.

**2. A human authors the contract; the model discovers the path** (`src/agent/spec.ts`). The
capability's id, description, typed inputs and outputs, sensitivity classifications and the *set*
of business outcomes are written by an engineer. The model works out which controls realise them.
Letting the model invent the schema too produces output names that drift on every re-recording,
and the calling agent's interface must be stable across re-recordings even though the steps are
not.

**3. The app profile is separate from the capability.** Allowlist, viewport and global recovery
rules are properties of the *application*, authored once per vendor product and inherited by
every capability recorded against it. A maintenance interstitial is not a fact about
"lookup-member-balance".

**4. Discovery has a second phase.** After the happy path, the agent is re-run once per declared
business outcome with probe inputs that provoke it, and records the detector by observing the
real screen. The error taxonomy is learned, not hand-written.

**Trade-offs I accepted.** Playwright ties the reference surface to Chromium. The two-phase
discovery costs one extra model run per outcome. The authored contract means a human must write a
spec before recording — I think that is correct, but it is real friction, and it means this is not
a "point it at an app and press go" tool.

---

## Artifact schema

Full schema: `src/artifact/schema.ts`; generated JSON Schema: `docs/capability.schema.json`;
a recorded example: `evidence/`.

```
Capability
  id, version, name, description, state: draft|approved|deprecated
  surface     { kind, entry, application{vendor,product,versionRange}, viewport }
  inputs[]    { name, type, required, sensitivity, pattern|enum, description }
  outputs[]   { name, type, sensitivity, required, description }
  steps[]     { id, intent, action, risk, precondition?, checkpoint?, recovery[], timeoutMs }
  outcomes[]  { code, description, when: Condition, message, partialOutputs[] }
  globalRecovery[]  { id, when: Condition, do: Action[], maxAttempts }
  successCondition  Condition
  policy      { allowedOrigins, allowedPathPrefixes, maxUnattendedRisk, neverPersist, … }
  provenance  { recordedAt, recordedBy, goal, model, runId, transcriptDigest }
  tenantOverlays[]  { tenantId, entry, terms{}, locatorOverrides{}, extraRecovery[], … }
```

**It is a contract, not a macro.** Everything a calling agent needs to decide *whether to call
this* — what it needs, what it returns, which non-failure answers it can give, how risky it is —
sits above the `steps` array. The proof that this is real rather than aspirational is
`src/cli/catalog.ts`: projecting a capability into an Anthropic tool definition is a mechanical
transform with no extra information required. If the schema had been designed as a step list with
metadata bolted on, that projection would need a second source of truth.

**Locators are ranked, with a declared robustness tier.** A single selector is a bet that one
handle survives; on a legacy screen the available handles are a mixed bag, and which one holds is
a per-tenant, per-version question.

| tier | strategies | why it is where it is |
|---|---|---|
| `semantic` | `role`+accessible name, `label` | survives restyling and markup rewrites; ports to desktop UIA/AX |
| `structural` | `nearText`, `fieldName` | the legacy workhorses — the visual label, and the form-control `name` that is part of the server wire contract |
| `positional` | `tableCell{rowContains, column}` | survives restyling, breaks on column reorder |
| `fragile` | `css`, `xpath` | recorded so nothing is unrecordable, flagged so review sees the dependency |

`nearText` is the one that makes hostile surfaces tractable. A table-layout form has no
`<label for>`, so the field has no accessible name — but "the input after the static text
*Member Number:*" is exactly how the operator, the vendor manual and the training material all
refer to it. Similarly `tableCell{rowContains:"SHARE SAVINGS", column:"Current Balance"}` reads a
balance without depending on row order or on the member's account number.

Resolution takes the first strategy that matches **exactly one visible control**. Ambiguity is
treated as that strategy failing, not as "take the first" — on a screen that moves money, acting
on an arbitrary one of three matches is worse than not acting.

**Sensitivity is a schema field, not a logging concern.** Every input and output carries
`public | identifier | financial | pii | secret`, and the redactor is driven from it. A code path
that forgets about a field cannot leak it, because the values were registered from the contract
before the first log line was written. (This was a real bug during development: `run.start`
echoed the caller's inputs one line before registration ran. The test
`never writes financial or PII values into the evidence file` caught it.)

**Exceptional states are declared data.** `outcomes` and `recovery` live in the artifact, so a
reviewer sees every non-happy-path the capability knows about in one file, and adding one is a
data change rather than a code change.

**Invariants Zod cannot express are checked on save *and on load*** (`validateCapability`):
extracts must bind to declared outputs, every required output must actually be extracted, every
state-changing step must have a checkpoint, templates may only reference declared names, secrets
may never be outputs, and targets with only fragile strategies raise a warning. Re-validating on
load matters because the artifact is a file humans edit — a hand edit that breaks an invariant
should fail loudly at load, not halfway through a live banking screen.

**The write-step invariant is enforced during the run, not at save time.** Checking it only on
save is too late: a recording that reaches `build()` with an unproven write step is discarded
whole, after several minutes and a model call, and the screen that would have proved the step is
long gone. So the loop refuses the model's *next* tool call while a recorded write step has no
checkpoint, and asks for one on the screen the action just produced. A checkpoint must also be
**new** wording. On this application "Open Sub-Account" is both the link you click and the title
of the form it opens, so a checkpoint on it would hold even if the click did nothing — precisely
the "replay reports success having changed nothing" failure the invariant exists to prevent. The
loop compares the proving text against the screen captured immediately before the action and
rejects anything that was already there. Both refusals are visible in the discovery transcripts
under `evidence/`, with the model recovering in-run and choosing `"Opening Deposit:"` instead.
A recording that still fails validation is written to its run directory as
`rejected-capability.json` — never to the capability store, where replay could load it — so a
reviewer reads the steps rather than only the complaint about them.

**Versioning.** `<id>@<version>.json` in git, one file per version. A database was the obvious
alternative and was rejected: the artifact's whole purpose is reviewability, and a file in git
gets diff, blame, review and rollback for free. Two versions coexist, so a caller pinned to 1.0.0
is unaffected by 1.1.0 landing. New recordings are `draft`; unattended replay requires `approved`.

---

## Determinism & error handling

**What determinism rests on**, in order of how much work each does:

1. **Ranked semantic-first locators.** No coordinates, no recorded DOM path as the primary handle.
2. **No sleeps.** Every wait is "until this declared condition holds, or this deadline passes".
   There is no unconditional sleep in the replay path — the only sleeps are poll intervals inside
   deadline-bounded waits — which is what keeps a slow tenant from being a
   flaky tenant. The resolver retries the whole ranked list until its deadline rather than
   blocking inside one strategy, so a page that is 200 ms late does not permanently downgrade the
   run to a fragile fallback.
3. **Checkpoints after every state-changing step.** A click that did nothing is caught at the step
   that caused it, not three steps later as an inexplicable locator failure. The schema *refuses
   to save* a non-`read` step without one.
4. **Outcomes checked after every action**, before the checkpoint is judged.

That ordering is the single most important line in the engine. "No member record found" makes the
detail-page checkpoint fail. Judging the checkpoint first would report a legitimate answer as a
fake outage. The app gets to speak before anything is called broken.

**The result contract** (`src/replay/contract.ts`) has exactly three statuses:

| status | meaning | caller does |
|---|---|---|
| `success` | flow completed, declared outputs populated | uses the outputs |
| `business_outcome` | the app gave a legitimate non-happy answer (`MEMBER_NOT_FOUND`, `MEMBER_RESTRICTED`) | treats it as **data** |
| `failure` | automation could not complete; assume nothing about app state | retry or escalate, per `retryable` |

Conflating the first two is the mistake the brief names, and it is fatal in a way that is easy to
under-rate: if "this member does not exist" arrives as an exception, the calling agent cannot tell
it from "our robot is broken", so it must escalate both, and the system stops being worth having.

**Recoverable conditions are deliberately not a status.** A transient slow load, a maintenance
interstitial, a session that expired mid-run — these are handled inside the run and reported in
`recoveries[]`. Making them a status would push the retry decision onto a caller with strictly
less information than the engine had. They stay *visible* because a capability that silently
recovers five times a day needs a fix.

**Failure categories**, each with `retryable` decided by the engine rather than left to the
caller's judgement — the engine knows that a checkpoint failure after a write may have
half-applied and must not be blindly retried, while a timeout on a read is free to retry:

`input_validation` · `policy_denied` · `locator_unresolved` · `action_failed` ·
`precondition_failed` · `checkpoint_failed` · `success_condition_failed` · `timeout` ·
`app_error` · `recovery_exhausted` · `escalation_timeout` · `operator_aborted` · `internal`

Three of these earn their separate existence. `input_validation` is rejected in microseconds
against the declared schema before a browser is opened — a malformed member ID should never be
typed into a bank screen. `app_error` is distinguished by a step-scoped HTTP-status check, so a
500 does not send someone hunting for UI drift when the application is simply down. `internal` is
separated so a defect in *this* system is never misread as drift in the customer's.

Failures carry step id, intent, index, **expected vs. observed**, the per-strategy locator
diagnosis (which strategies were tried, how many elements each matched, and why), a screenshot and
a full frame-by-frame DOM snapshot.

**Recovery rules** are bounded twice: `maxAttempts` per rule, and a fixed action list. Recovery
can never become an improvising agent wearing a different hat. On a checkpoint failure the engine
re-checks *before* redoing anything — re-authentication usually lands exactly where the step was
heading — and only replays the action if the step is classified `read`. Redoing a write to satisfy
a recovery rule is not a trade I am willing to make.

**Drift, secondarily.** Every resolution records which strategy index won. Falling through to a
lower tier is not an error — that is what the ranked list is for — but it is recorded in
`drift[]`. That turns drift from an outage into a backlog item, and it costs nothing: the data is
a by-product of normal replay rather than a monitoring system I had to build.

All of the above is asserted in `test/replay.integration.test.ts` against the live app, with no
model involved.

---

## Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `src/surface/types.ts`. Everything above it — artifact,
agent loop, replay engine, policy, escalation — imports that interface and knows nothing about
Playwright, the DOM, or the web. A surface must do four things: `observe`, `resolve` (reporting
*which* strategy won), `perform`, and cede/reclaim its live session.

The reason this is more than a nominal interface is that the *locator vocabulary was chosen for
portability*. `role` is restricted to the ARIA subset with faithful equivalents in Windows UI
Automation and macOS AX. `nearText` is "the control after this static text", which is exactly how
you address an unlabelled field in a Win32 dialog. `tableCell` maps to UIA's grid pattern.
`framePath` addresses a frameset document by name and maps to a window/pane path on desktop. The
strategies that do *not* port — `fieldName`, `css`, `xpath` — are marked web-specific and simply
never emitted by a desktop recorder; because strategies are a ranked list rather than one string,
their absence degrades the list instead of breaking it.

A legacy web app is the case actually implemented: framesets, table layout, no test IDs,
unlabelled inputs. A desktop driver is not built (see **Cuts**). What it would need: a UIA/AX
inventory producing the same `ControlDescriptor`, and a `perform` over UIA patterns. Steps,
outcomes, checkpoints, policy, escalation and the contract are unchanged.

**Multi-tenant reuse.** Hundreds of institutions on the same vendor product, configured and
versioned differently. Artifacts are recorded once against a reference instance; each tenant
contributes a **`TenantOverlay` — a patch, never a copy**. Resolution happens before the engine
runs, so the engine has no idea tenants exist: multi-tenancy is a resolution-time concern.

The overlay's most useful field is `terms`, a vocabulary map:

```json
{ "tenantId": "harbor", "entry": "{{env.baseUrl}}/t/harbor/",
  "terms": { "Member Search": "Customer Search", "Member Detail": "Customer Detail",
             "Current Balance": "Available Balance", "Member": "Customer", "Search": "Find" } }
```

Because the overwhelmingly common way two tenants on one product diverge is *words*, not
structure. Six lines re-point every accessible name, every near-text anchor, every column header
and every checkpoint, without touching a step. Substitution is longest-phrase-first over
non-overlapping regions, so "Member Search" becomes "Customer Search" rather than being mangled
into "Customer Find" by a shorter later rule.

Crucially the substitution is **additive**: locators get the tenant variant *prepended* and keep
the base strategies as fallback; conditions become `any[tenant, base]`. A tenant whose vocabulary
map is wrong degrades to base behaviour instead of breaking. That is the difference between an
overlay and a fork.

Overlays may add recovery rules, add outcomes, prepend locator strategies for a named step, and
re-point the entry and allowlist. They may **not** remove, reorder or retype steps. A tenant that
needs a different step list needs a different capability, and making that impossible to express by
accident is how "reused across 300 institutions" is kept from quietly meaning "300 divergent
forks".

Drift management: `drift[]` from every replay says which tenants are falling through to lower
tiers. A tenant that consistently degrades needs an overlay strategy *before* it breaks.
`surface.application.versionRange` records which product version the recording was made against,
so a tenant upgrading outside the range is a known unknown rather than a surprise.

This is demonstrated, not just described: the integration suite replays the *same artifact*
against Harbor First Bank, a second tenant on MemberLink 3.4.2 with different terminology and an
extra disclosure interstitial, via a term map alone.

---

## Escalation & handoff

**Detecting "stuck"** is not one condition, so it is a closed set of six, each of which gets a
specific operator screen rather than a generic stack trace:

| reason | raised when |
|---|---|
| `discovery_stuck` | the model exhausted its turn budget, or called `give_up` |
| `locator_unresolved` | no strategy resolved a recorded target |
| `unknown_state` | a checkpoint failed, no declared outcome matched, no recovery rule applied |
| `recovery_exhausted` | a rule matched but could not fix the state within `maxAttempts` |
| `confirmation_required` | policy says an irreversible or over-risk step needs a person |
| `credential_required` | the app wants something the automation cannot supply |

`unknown_state` is the one that matters most in production: the application has shown something
the capability was never taught, which is neither a bug nor a business outcome, and the only safe
options are a human or a clean stop.

**Control transfer.** One session, one holder at a time, every transition logged:

```
automation ──cede──► operator ──release──► automation
     └──────────────── abort ─────────────► none
```

Two properties matter more than the mechanism.

*The session is the same object.* The human does not get a fresh browser pointed at the same URL —
they get the live page, with its cookies, its server-side session, its half-filled form and its
frameset scroll position. Anything else loses exactly the state that made the escalation
necessary. Here that is literally the same Playwright `Page`; in a deployed system it is the same
browser container reached over CDP, and the endpoint is handed to the operator in the ticket so
the seam is real rather than hypothetical.

*Holdership is checked, not assumed.* Every automation action calls `assertHolder('automation')`
first and throws immediately if a human holds the session, rather than racing the operator's
mouse. Asserted in `test/replay.integration.test.ts`.

**The ticket carries enough context to act**: capability and version, tenant, step index/total,
step intent, why it stopped, expected vs. observed, current URL, a screenshot, and a direct
session endpoint. All redacted on the way out.

**The operator console** (`src/escalation/operator-console.ts`) is minimal but real: the live
screen on a poll, the live control inventory, and release buttons. The operator acts *by control*
("the Override Code field"), not by pixel — reusing the same perception layer the agent uses. That
is not just convenience: it means the human's actions are recorded in the same vocabulary as the
automation's, so "what did the operator actually do" is answerable, and a repeatedly-performed
manual fix becomes a candidate for promotion into the artifact's recovery rules rather than
folklore.

**Handing back.** Three dispositions: `resume` (retry the step), `resume_step_done` (the human did
it; skip to verification), `abort`. Whatever the operator says they did, **the checkpoint is what
decides** — a human claiming "done" does not skip verification. Every operator action, the notes,
and both transfer directions land in the run's evidence.

An unanswered escalation times out to an explicit `ESCALATION_TIMEOUT` failure rather than holding
a browser and a caller open forever.

`src/escalation/auto-operator.ts` is a scripted supervisor used to demonstrate and test the path
non-interactively. It is an ordinary HTTP client of the operator API — same claim, same act, same
release calls the browser console makes, no privileged back door — so what it exercises is the
real mechanism. What is mocked is the *judgement*: it matches on screen wording and applies a
fixed playbook where a person would read and decide.

---

## Safety

**Four layers, deny by default.**

*Network.* Playwright route interception aborts any request outside the allowlist, so a stray
redirect or injected script cannot reach an origin the capability was never permitted to touch.

*Navigation.* `PolicyEngine.checkUrl` against origin+path prefixes, checked on the **rendered**
URL. (Another real bug the tests caught: the check originally ran against the unrendered template,
which both refused every parameterised navigation and would have said nothing about where the run
actually went.)

*Action type.* An explicit verb allowlist; anything absent is refused even if a step declares it.

*Risk.* Every step carries `read | write_reversible | write_irreversible`, derived at recording
time from the action and the control's own label — not from the model's opinion, so a run cannot
talk its way into unattended irreversible writes. The policy engine additionally overrides the
recorded class when a control's label matches an irreversible hint ("Permanently", "Confirm and
Post", "Wire"): a recording could misclassify, but a button reading *Close Relationship
Permanently* should never be pressed unattended regardless.

**Irreversible actions require confirmation rather than being blocked.** Blocking makes the system
useless for the write flows that carry most of the business value and pushes operators back to
doing the whole task by hand. Requiring a human decision at exactly the irreversible moment keeps
the other twelve steps automated while putting the accountable decision where a regulator would
expect it — and it reuses the escalation channel, so there is one control-transfer mechanism, not
two. **Discovery never performs an irreversible action at all**: a recording run must not move
money, so the agent is told to reach the confirmation screen and stop.

That constraint leaves a hole the schema has to close. If the model can never record the final
post, something else has to author it — so `memberlink.open-sub-account@1.1.0` takes the recorded
1.0.0 steps and appends the post as a **human-authored step**, listed in
`provenance.humanEditedSteps`. The division is the honest one: the model contributes the path it
can safely discover, a person contributes the step that moves money, and the artifact records who
wrote what. Both versions ship, so a caller pinned to 1.0.0 still stops at confirmation.

**Idempotency is declared, because after an ambiguous failure nobody can tell whether a write
landed.** `checkpoint_failed` on a submit means the click happened and the expected screen did
not, which is exactly the state where a retry might post twice. Encoding "do not retry" in the
error taxonomy is a counsel of despair; the useful thing is to let the artifact say how to find
out. A step may declare:

```
idempotency: { key, guard, outcome }
```

`guard` is a condition that holds *when the write has already been applied*, evaluated on the
screen before the step acts, with the caller's values rendered in. When it holds, replay reports
the declared business outcome and does nothing — `SUB_ACCOUNT_EXISTS` rather than a second
account. The guard sits on the first step that changes anything rather than on the commit itself,
because the member detail screen is the last screen that can answer the question; by the time you
are on the confirmation page, the app no longer shows you what the member already owns. Only the
capability knows that, which is why this is artifact data and not engine cleverness.

`validateCapability` warns when a `write_irreversible` step carries no guard. It is a warning and
not an error because some writes genuinely have no detectable trace, and a rule that cannot be
satisfied is a rule people learn to ignore.

The target application does **not** deduplicate: posting the same sub-account twice appends a
second row, and the member's detail screen shows both. That is deliberate. Had the mock quietly
swallowed duplicates, the guard could be deleted and every test would still pass, and the
guarantee would be fiction. A test asserts the duplicate is observable.

**Data handling.** Two mechanisms, because either alone is insufficient. *Declared* redaction is
driven by the artifact's `sensitivity` fields — exact values registered before the first log line
and scrubbed wherever they appear, in a log line, a page-text excerpt, an error message or an
escalation payload. *Pattern* redaction (SSN, Luhn-checked card numbers, bearer tokens, emails) is
a backstop for values that arrived from the page rather than the caller.

Credentials never reach the model. The agent asks for `{{env.secret_OPERATOR_PASSWORD}}` and the
harness types the real value, so it cannot be echoed into a transcript, a checkpoint or a recorded
step. Password field contents are never lifted out of the page by the inventory. Financial and PII
outputs are **returned to the caller but never persisted** — the agent asked for the balance; we
are not entitled to keep it. Secrets can never be outputs; the schema refuses to save a capability
that declares one.

**Limits, stated plainly.**

- This is a *policy* boundary, not a security boundary. A capability recorded to do something
  harmful within its allowlist using only read-classified steps would pass. Review of the artifact
  — which the schema is designed to make readable — is the control for that, not this engine.
- **Redaction cannot make a screenshot safe.** Screenshots are therefore captured only on failure
  and escalation, stored outside the artifact, and must be treated as regulated data with the same
  retention as the underlying system. This is the weakest part of the safety story.
- Pattern redaction both over- and under-matches. Only the declared path is relied upon.
- An operator who attaches over raw CDP instead of the console is outside the action recording.
- Prompt injection from page content into the discovery agent is bounded (the model can only pick
  refs and call a fixed tool set, policy is enforced on every call, irreversible actions are
  refused) but not eliminated. Replay is immune by construction — there is no model to inject
  into, which is a real security argument for record-once/replay-many and not only a cost one.

---

## What the target app does not do, and what happens when it does

I built both sides. That is a real weakness in this submission and the honest response is to attack
my own harness rather than to note the risk and move on. Four things real legacy systems do that
MemberLink otherwise does not are available as armed modes, and every one of them has a committed
evidence run.

| mode | what it does | result | verdict |
|---|---|---|---|
| `renamedfield` | the search input's wire name becomes `TXT0041`, as a vendor minor version really does | **success**, no drift | the ranked list prefers the visual label; `fieldName` was only ever a fallback, so nothing degrades |
| `multirow` | search answers with three matching households instead of jumping to the record | `checkpoint_failed`, naming what it expected | correct, and a genuine gap: the schema has no vocabulary for "pick the row where X" |
| `interstitial-sticky` | a maintenance notice that will not clear | `recovery_exhausted`, with the rule reporting `succeeded: false` | correct — and it was wrong until this mode existed (see below) |
| `confirmdialog` | a native `confirm()` in front of the submit | `checkpoint_failed` quoting the dialog text and naming the fix | correct after a change; silently wrong before it |

Two of those found real defects.

**Recovery never checked whether it had worked.** A rule reported success if its actions *ran*.
Against a notice that reloads itself, "click Continue" therefore counted as a repair, the run
carried on, and it died several steps later as `locator_unresolved` — sending a reader hunting for
a renamed field while the application sat on an unread banner. Recovery now re-evaluates its own
trigger afterwards, and a rule whose trigger still holds is recorded as `succeeded: false`. A step
whose recovery gave up fails as `recovery_exhausted` in both the checkpoint and the action paths,
from one shared definition rather than two divergent ones. This is the same mistake the checkpoint
rule exists to prevent — acting is not achieving — reappearing one layer down.

**Native dialogs were invisible.** Playwright dismisses them by default, so a `confirm()` in front
of a write turned into "the click did nothing", with no trace of why. The surface now records
every dialog and what was answered, and a step declares `dialog: "dismiss" | "accept"`. Dismiss is
the default deliberately: accepting an unread dialog is exactly the improvisation this design
refuses, and on a back-office screen the dialog is often the last thing standing between the
automation and something nobody authorised. A step that must answer one says so, and that consent
is visible in the artifact diff. When a dismissed dialog explains a failure, the error quotes the
dialog and names the one-line fix.

What remains genuinely soft about the target app, stated plainly rather than discovered by a
reviewer: it runs **no client-side JavaScript** outside the armed `confirmdialog` mode, so every
interaction is a form POST and a full page load. `settle()` waits for `domcontentloaded` and
nothing more. Against an AJAX-refreshed grid or a JS-driven frame swap that is not enough, and the
determinism claim is therefore demonstrated against a surface that is hostile to *markup*-based
automation while being friendly to *timing*-based automation. Fixing that honestly means a
different target app, not a different wait.

## Cuts

**Deliberately not built, with the seam left clean.**

- **Desktop surface.** The abstraction, the portable locator vocabulary and the reasoning are in
  place; no UIA/AX driver. Highest-value next thing to build, because it is the claim I would most
  want to prove rather than argue.
- **Real co-browsing console.** Explicitly out of scope in the brief. What exists is a polled live
  screen plus semantic control actions. Production needs streamed video, input forwarding,
  presence, and operator authn/authz — none of which changes the control-transfer model.
- **Durable escalation queue.** In-process `Map` + promise. The interface is the queue interface;
  swapping it is a change to `broker.ts` alone.
- **Multi-tenant plumbing.** Overlays and resolution are built and tested; no tenant registry,
  routing or per-tenant credential vault. The brief says designing for scale is valuable and
  building it prematurely is not.
- **Bounded LLM recovery on replay failure.** Attractive, and I left it out on purpose: it is the
  feature most likely to quietly reintroduce nondeterminism into the path whose entire value is
  being deterministic. If added, it should be single-step, policy-checked, recorded as evidence,
  and off by default.
- **Authored, not discovered:** the capability contract and the app-profile recovery rules. See
  Architecture for why.

**Why I built the target app** rather than using a public demo site: the brief's central claim is
that the interesting failures are runtime exceptional states, and I could not *reproducibly*
demonstrate a session timeout, a surprise interstitial, a permission denial and a 500 on someone
else's sandbox. Building it also let me make the surface genuinely hostile — real framesets,
table layout, no test IDs, unlabelled inputs — instead of accidentally choosing an easy target and
dodging the premise. Cost: about two hours, and the honest caveat that I built both sides, so the
locator strategies were not tested against markup written by someone else.

**With more time, in order:**

1. A UIA desktop driver for one flow, to prove the surface seam.
2. Multi-run stability scoring — replay N times, attach a flakiness signal to the artifact, and
   gate `draft → approved` on it. The `drift[]` data already collected is most of the input.
3. Overlay *inference*: replay a base artifact against a new tenant in a dry-run mode and propose
   the term map from what fails, instead of hand-writing it.
4. Promotion of repeated operator interventions into candidate recovery rules — the console
   already records human actions in the right vocabulary for this.
5. A proper approval workflow: diff between artifact versions, reviewer sign-off, and a
   `humanEditedSteps` audit trail (the field exists; nothing writes it yet).

**Known rough edges.** The inventory caps at 80 value cells per frame and will need paging for
large grids. `tableCell` assumes the header row is the table's first row. The scripted operator
matches on screen wording, which is brittle by design but is test scaffolding rather than product.
Discovery cost is roughly one model run per business outcome plus one for the happy path, which
will not scale to a capability with a dozen declared outcomes.
