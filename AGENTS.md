# Project guidance for Codex

This repository is an interface.ai take-home: a real LLM discovers a flow on a live local back-office UI, a reviewed JSON capability records it, and replay executes without model decisions. Preserve that boundary. Do not replace the committed discovery evidence with scripted tests or claim a new discovery run without a real model call.

## Commands and environment

- Node.js 20 or newer; use `npm ci` and `npx playwright install chromium` for a fresh checkout.
- Run `npm run typecheck` and `npm test` before claiming code is ready. The full suite starts a local target on port 4188 and takes several minutes; do not run two copies concurrently.
- `npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456` runs without a model key and starts the mock target app if needed.
- `npm run discover -- --spec capabilities/specs/memberlink.lookup-member-balance.json` requires `ANTHROPIC_API_KEY` in a local `.env`. Never show or commit `.env`.
- PowerShell setup: `Copy-Item .env.example .env`; edit only the local `.env`. The mock credentials in `.env.example` are synthetic.

## Where to work

- `src/agent/` is model-driven discovery and recording. Only this path imports the Anthropic SDK.
- `src/artifact/` defines and stores capabilities and tenant overlays. Keep the artifact contract stable and version changes intentionally.
- `src/replay/` must remain deterministic and model-free. Distinguish business outcomes, recoveries, and failures in the returned contract.
- `src/surface/` owns UI perception and action; preserve its seam for other surface drivers.
- `src/policy/` enforces allowlists, risk gates, and redaction. `src/escalation/` owns live-session handoff.
- `target-app/` is a synthetic legacy-like test surface. `test/` includes the live Playwright suite.
- `README.md` is the reviewer runbook; `REPORT.md` is the brief submission write-up; `docs/DESIGN_NOTES.md` holds extended reasoning; `evidence/README.md` maps the canonical runs.

## Safety and evidence

- Keep keys, tokens, credentials, and real customer data out of Git, artifacts, transcripts, snapshots, and logs. Treat committed evidence as synthetic demo material only.
- Preserve the two authentic discovery transcripts and their provenance digests. Do not rewrite historical evidence to make it look like a new run.
- Every replay status should write a redacted `result.json`. Failure paths should capture useful diagnostics without leaking declared sensitive values.
- Before pushing publicly, check the entire Git history for secrets, confirm the Git author identity, and verify the remote and final commit SHA.
