# Computer-Use Automation — record once, replay many

An LLM learns how to drive a legacy back-office application **once**. What it learned is frozen
into a typed, versioned, reviewable **capability artifact**. After that the flow **replays
deterministically with no model in the decision loop**, returning a structured result that tells
a calling agent the difference between "the balance is $4,820.15", "no such member" and "our
automation is broken" — and pulling a human into the *same live session* when it cannot safely
proceed.

The design write-up, including every trade-off and what was deliberately cut, is in
**[REPORT.md](./REPORT.md)**.

---

## The target application

There is no real bank system here. The repo ships its own stand-in: **MemberLink Core
Servicing**, a deliberately hostile legacy web app (`target-app/`).

- a real `<frameset>` — two independent documents, no SPA router, no history API
- table-based layout, no `id` or `data-testid` anywhere, labels are sibling `<td>` text
- **two tenants on the same vendor product**: `summit` (v3.1.7, "Member", "Search") and
  `harbor` (v3.4.2, "Customer", "Find", plus a disclosure interstitial)
- switchable runtime faults: slow response, surprise maintenance notice, session expiry, HTTP 500
- a supervisor-override gate that the automation cannot satisfy on its own
- posting a sub-account really posts it: the member's accounts change, and posting twice appends
  two rows, so a double-post is visible rather than quietly absorbed
- synthetic data only; the one credential it accepts is fake and non-secret

Everything is at `http://127.0.0.1:4173`.

---

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env         # then set ANTHROPIC_API_KEY for the discovery step
```

`.env`:

```
ANTHROPIC_API_KEY=sk-ant-...        # discovery only — replay never reads this
CUA_MODEL=claude-sonnet-5           # optional; what the shipped recordings used
CUA_SECRET_OPERATOR_ID=OPR001       # fake training credentials for the mock app
CUA_SECRET_OPERATOR_PASSWORD=training-only
CUA_SECRET_OVERRIDE_CODE=4417       # what the scripted supervisor types during escalation
```

Credentials are read from the environment, typed into the app, and **never** written to the
artifact, the logs, or the model's context.

### Running without a model

Everything except discovery works with `ANTHROPIC_API_KEY` unset — that is the point of the
design, and the test suite enforces it:

```bash
npm test          # full suite: replay, recovery, escalation and the shipped artifacts,
                  # against the live app, with no model anywhere
```

---

## Demo path

**1. Start the target app** (optional — every command below starts it if it is not already up):

```bash
npm run target
```

**2. Discovery — the real LLM run.** Needs `ANTHROPIC_API_KEY`.

```bash
npm run discover -- --spec capabilities/specs/memberlink.lookup-member-balance.json
```

The agent signs on, navigates the frameset, searches, reads the member's name and balance, and
records checkpoints. Then it runs one short probe per declared business outcome to learn their
detectors from the real screens. Output: `capabilities/memberlink.lookup-member-balance@1.0.0.json`
(state `draft`) plus a full evidence directory. Add `--headed` to watch it.

**3. Review and approve.** New recordings are drafts; unattended replay requires review:

```bash
# read capabilities/memberlink.lookup-member-balance@1.0.0.json, then:
#   "state": "draft"  ->  "state": "approved"
```

**4. Deterministic replay — success.** No model involved.

```bash
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456
```

```json
{ "status": "success",
  "outputs": { "memberName": "DELACROIX, RENE J", "savingsBalance": 4820.15 },
  "recoveries": [], "escalations": [], "drift": [] }
```

**5. Replay hitting a business outcome** — a legitimate answer, not a crash (exit code 3):

```bash
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=000000
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=999999
```

```json
{ "status": "business_outcome",
  "outcome": { "code": "MEMBER_NOT_FOUND", "message": "No member record exists for 000000." } }
```

**6. Replay hitting runtime faults.** `--chaos` arms a fault in the target app first.

```bash
# recoverable. interstitial and expire are cleared by a declared recovery rule and
# appear in recoveries[]; slow is simply absorbed by the step deadline, so it
# reports success with recoveries[] empty — the run survived, nothing was repaired
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456 --chaos slow
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456 --chaos interstitial
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456 --chaos expire

# hard failure: a structured, debuggable error with screenshot + DOM snapshot
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456 --chaos apperror --operator none

# caller error: rejected in milliseconds, before a browser is opened
npm run replay -- --capability memberlink.lookup-member-balance --param memberId=abc
```

`--operator none` is what makes the error case a *hard failure*. On the default `auto`, the engine
first offers the screen to a human; the scripted supervisor holds no playbook for an HTTP 500 and
releases the ticket as `abort`, so the run ends `operator_aborted` — correct behaviour, different
demo.

**7. Human-in-the-loop escalation.** Record the write capability, then replay it with a deposit
above the branch limit so the app demands a supervisor override the automation cannot supply:

```bash
npm run discover -- --spec capabilities/specs/memberlink.open-sub-account.json
# approve it, then:
npm run replay -- --capability memberlink.open-sub-account \
  --param memberId=123456 --param accountType="VACATION CLUB" --param openingDeposit=5000
```

The run pauses, cedes the live session, and raises an intervention request. With
`--operator auto` (the default) a scripted supervisor claims the ticket over the real operator
API, types the override code, hands control back, and the run completes.

To do it yourself instead, open the console in a browser:

```bash
npm run replay -- --capability memberlink.open-sub-account --operator console --headed \
  --param memberId=123456 --param accountType="VACATION CLUB" --param openingDeposit=5000
# then visit http://127.0.0.1:4180
```

Take control, act on the live screen by control name, and release with **resume**,
**mark step done**, or **abort**.

**7b. The irreversible post — the write that actually writes.** `@1.1.0` of the same capability
appends a human-authored `Confirm and Post` step. It exceeds the capability's unattended risk
ceiling, so replay stops and asks a person; the scripted supervisor authorises, and the
automation — not the human — performs the step, so the checkpoint still has to see the posted
screen:

```bash
npm run target        # keep ONE app running: posted accounts live in it
npm run replay -- --capability memberlink.open-sub-account@1.1.0   --param memberId=123456 --param accountType="VACATION CLUB" --param openingDeposit=250
```

```json
{ "status": "success", "outputs": { "reference": "SA-123456" },
  "escalations": [{ "reason": "confirmation_required", "disposition": "resume" }] }
```

The account now exists on the member's detail screen. Run the identical command again — a caller
retrying after an ambiguous failure:

```json
{ "status": "business_outcome",
  "outcome": { "code": "SUB_ACCOUNT_EXISTS",
               "message": "Member 123456 already holds a VACATION CLUB account; nothing was opened." } }
```

No second account, and no human was troubled, because nothing needed deciding. The artifact
declares an idempotency guard; the application itself does **not** deduplicate, and a test proves
a forced double-post appends a second row. With `--param openingDeposit=5000` the same run needs a
supervisor twice — once for the branch-limit override, once for the post.

`@1.0.0` still stops at the confirmation screen. Both versions are listed by `npm run catalog`.

**8. Cross-tenant reuse.** Apply a tenant overlay and run the *same artifact* against a second
institution on the same vendor product:

```bash
npm run overlay -- --capability memberlink.lookup-member-balance --overlay capabilities/overlays/harbor.json
npm run replay  -- --capability memberlink.lookup-member-balance --tenant harbor --param memberId=123456
```

The overlay is a term map (`Member`→`Customer`, `Search`→`Find`,
`Current Balance`→`Available Balance`) — no step is added, removed or reordered.

**9. The agent-facing catalog.** Saved artifacts projected as callable tools:

```bash
npm run catalog                  # human-readable listing
npm run catalog -- --tools       # Anthropic tool definitions, ready to pass to a model
npm run catalog -- --invoke memberlink.lookup-member-balance --param memberId=234567
```

---

## Layout

```
target-app/            the hostile legacy stand-in (frameset, tables, 2 tenants, faults)
src/
  artifact/            capability schema (Zod), validation, store, tenant overlays + term maps
  surface/             the surface seam: Surface interface, Playwright driver, control inventory
  agent/               spec (authored contract), discovery loop, recorder
  replay/              result contract + error taxonomy, deterministic engine
  policy/              allowlist / risk gate, sensitivity-driven redaction
  escalation/          session control, ticket broker, operator console, scripted operator
  evidence/            structured run logger
  cli/                 discover · replay · catalog · overlay · emit-schema
capabilities/
  specs/               authored capability specs (the input to discovery)
  overlays/            tenant overlays
  *.json               recorded artifacts
evidence/runs/<runId>/ run.jsonl · result.json · screenshots · DOM snapshots · transcript.json
docs/capability.schema.json   generated JSON Schema for the artifact
```

## Commands

| command | what it does |
|---|---|
| `npm run target` | start the mock application on :4173 |
| `npm run discover -- --spec <file>` | LLM discovery run; emits a draft artifact |
| `npm run replay -- --capability <id> --param k=v` | deterministic replay, no model |
| `npm run catalog` | list capabilities / emit tool definitions / invoke one |
| `npm run overlay -- --capability <id> --overlay <file>` | attach a tenant overlay |
| `npm run operator` | operator console standalone |
| `npm run schema` | regenerate `docs/capability.schema.json` |
| `npm test` | full suite; no API key required, and a test enforces that |
| `npm run typecheck` | `tsc --noEmit` |

### Replay flags

`--param k=v` (repeatable) · `--tenant <id>` · `--chaos slow|interstitial|expire|apperror` ·
`--operator auto|console|none` · `--headed` · `--allow-draft` · `--base-url <url>`

`--chaos` and `--operator` reject an unrecognised value rather than accepting it silently.

Exit codes: `0` success · `3` business outcome · `1` failure · `2` usage.

---

## Evidence

`evidence/` contains a recorded artifact plus logs from a real discovery run and from several
replay runs — success, a business outcome, a recovered interstitial, a hard failure, and an
escalation with human handoff.

Declared values — inputs, credentials, and any value bound to a declared output — are registered
with the redactor before the first log line and scrubbed on the way to disk. Replay evidence is
clean of PII and financial values by construction, and a test asserts it.

Discovery transcripts are the documented exception, and the limit is worth stating plainly: a
transcript contains the page text the model was shown, and the redactor can only scrub values it
was told about. A capability that declares a name as an output has that name redacted everywhere;
`memberlink.open-sub-account` declares only a reference number, so the member name it happened to
read on the way past survives in that transcript as incidental page text. This is why transcripts
live outside the artifact, carry only a digest into it, and are treated as regulated data with the
same retention as the source system. Scrubbing arbitrary unlabelled PII out of page text would
need a classifier, and a classifier that is 98% right is not a control you can put in front of a
regulator.
