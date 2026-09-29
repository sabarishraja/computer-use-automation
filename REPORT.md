# Design write-up

## Architecture

The system records a task on a deliberately awkward local back-office application, MemberLink, then runs the resulting capability without a model. MemberLink uses a frameset, table-based forms without test IDs, two tenant variants, and switchable runtime faults. The happy path is member lookup or opening a sub-account through confirmation. It uses synthetic data and fake operator credentials.

An engineer writes a capability spec: goal, entry point, typed inputs and outputs, business outcomes, and application policy. During discovery, Claude receives an accessibility snapshot and a numbered control inventory. It chooses controls by temporary reference; the Playwright surface resolves each reference and records ranked locator strategies. A second discovery phase probes declared business outcomes on real screens. The recorder emits a versioned JSON capability, separate from the model transcript. Replay reads that JSON and executes a fixed step sequence. Its code path has no model dependency.

This is one TypeScript process with distinct modules for the surface, agent, artifact, policy, replay, logging, and escalation. Typed interfaces preserve the seams a service deployment would need without adding a queue or database for a take-home. The trade-off is that the reference surface is Chromium, and an engineer must author the contract before discovery. Both choices keep the callable interface stable across recordings. The complete rationale and adversarial test notes are in [docs/DESIGN_NOTES.md](docs/DESIGN_NOTES.md).

## Artifact schema

Each `capabilities/<id>@<semver>.json` declares a name and description, `draft | approved | deprecated` state, vendor/product/version binding, typed inputs and outputs with sensitivity classes, ordered steps, allowed origins and action risk, business outcomes, and provenance. A step records its intent, action, risk class, target locator, precondition, checkpoint, timeout, and recovery rules. The generated machine-readable schema is `docs/capability.schema.json`.

A target has a ranked locator list: accessible role/name first, then nearby text or table structure, then web-specific field name, CSS, XPath, or position. The recorder derives these from the observed control; the LLM never invents a selector. Frames are identified by path. A non-read step must include proof of its resulting state. Inputs and outputs form the calling agent's contract; `npm run catalog -- --tools` exposes them as tool definitions, and `--invoke` uses the same replay engine.

The discovery runs produced the approved balance lookup and sub-account confirmation capabilities. Version `1.1.0` adds a clearly marked human-authored irreversible post step to the latter; discovery itself stops before posting. New recordings are drafts, and unattended replay requires approval. Git provides review, diff, and rollback for each version.

## Determinism & error handling

Replay validates parameters before opening a browser, resolves each target through the ranked strategies, waits against deadlines instead of fixed sleeps, and checks the expected state after every change. It checks declared business outcomes before judging a failed checkpoint: `MEMBER_NOT_FOUND` is a valid answer, while an unrecognized screen is not. It verifies required outputs and the final success condition before returning success.

The result contract has three statuses: `success` with typed outputs; `business_outcome` with a declared code and any valid partial outputs; and `failure` with category, step, expected versus observed state, retryability, and evidence paths. Recoveries remain visible in `recoveries[]` on the final result. Known maintenance notices and expired sessions have bounded recovery rules. A slow response is absorbed by a deadline. The engine will not automatically repeat a write after an ambiguous checkpoint failure. A pre-write idempotency guard can return `SUB_ACCOUNT_EXISTS` instead of posting a duplicate.

Failures such as an application 500, unresolved locator, persistent interstitial, or unexpected native dialog stop with a structured diagnosis. Failure evidence includes a screenshot and frame snapshot; every replay status now persists `result.json`. The integration tests exercise these paths against the live local app with the model key unset. Locator degradation is reported in `drift[]` for review before it becomes an outage.

## Heterogeneity & multi-tenant

`src/surface/types.ts` defines observation, locator resolution, action, condition, and session-control operations. The current `WebSurface` handles the legacy frameset through accessibility semantics and nearby visible labels. A desktop UI Automation or accessibility driver could implement the same control and action contract; web-only locator tiers would be absent. Desktop support remains a design seam, not an implemented claim.

An artifact is bound to a vendor product and compatible version range. A tenant overlay can change entry point, allowlist, terminology, and selected locators or recovery rules without copying or reordering the base steps. The Harbor overlay replays the Summit balance capability against a second institution with changed vocabulary and an extra disclosure screen. Resolution records which locator tier worked; repeated fallback or an out-of-range vendor version calls for overlay review or a new artifact, rather than silent reuse.

## Escalation & handoff

Discovery can raise a ticket when it exhausts its step budget. Replay can do so when it cannot resolve a target, cannot recover, reaches an unknown state, or needs approval for a risky action. The ticket includes the capability and current step, reason, expected and observed state, URL, screenshot, and live session access.

`SessionController` gives one holder at a time: automation cedes the *same* Playwright page and cookies to the operator, and automation actions assert ownership before proceeding. The minimal operator console shows the live screen and control inventory, accepts control actions, and releases with resume, mark-step-done, or abort. The checkpoint still verifies the state after handback. Actions and ownership changes are logged. A scripted supervisor uses that same HTTP API for repeatable tests; its judgment is mocked, while the handoff mechanism is real. An unanswered ticket has a timeout.

## Safety

Discovery and replay enforce a configurable origin/path and action allowlist. Playwright also blocks out-of-allowlist network requests. Each step is classified as read, reversible write, or irreversible write; an irreversible post requires a human decision. The final post is human-authored and flagged in provenance. Discovery never performs it. Artifacts cannot declare secret outputs, and credentials are supplied through environment references rather than model-visible values.

Declared sensitive inputs and extracted outputs are registered with a redactor before logs are written; the CLI diagnostic prints input names, not values. Result files retain caller outputs only in memory and persist redacted placeholders. The CLI returns raw outputs on stdout as its caller channel, so it must not be redirected to general-purpose logs in production. The committed demo uses synthetic data. A limitation remains: incidental names in a page transcript or DOM snapshot, and pixels in a screenshot, cannot be reliably sanitized by the exact-value redactor. Production evidence would require restricted storage and retention or a stronger capture/redaction boundary; the committed demo must not be used with real customer data.

## Cuts

I built the local target to reproduce errors safely and deterministically; this also means I control both the app and the harness. Hostile modes test renamed fields, ambiguous multi-row results, a notice that will not clear, and a native confirmation dialog. Those tests caught actual recovery and dialog-handling defects. The target still has little client-side JavaScript, so AJAX-heavy timing is not proven.

I left out a desktop driver, streamed co-browsing, a durable escalation queue, tenant registry, and model-assisted replay recovery. The highest-value next tests are a desktop flow and an independently built JavaScript-heavy legacy app. After that, I would score multi-run stability and require reviewer sign-off for `draft → approved`. These additions do not change the current end-to-end thread: genuine LLM discovery, a reviewed artifact, model-free replay, runtime outcomes, and live-session handoff.
