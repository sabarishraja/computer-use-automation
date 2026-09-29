# Submission audit

Reviewed against the interface.ai take-home brief on 2026-09-29. The final file pass enumerated all 162 submission files, parsed every JSON and JSONL record, decoded every text file as UTF-8, and checked every PNG signature; it found no integrity errors. Source and test files were then reviewed by responsibility against the requirements below. The discovery transcript hashes were recomputed and matched the three approved artifacts. Historical evidence was retained without rewriting it.

| Brief requirement | Implementation and check | Status |
|---|---|---|
| 3.1 Goal-driven agent loop | `src/agent/spec.ts`, `loop.ts`, `recorder.ts`; live UI tool calls and model turns in the two discovery transcripts | Met |
| 3.2 Typed, reviewable capability | `src/artifact/schema.ts`, `store.ts`, generated `docs/capability.schema.json`, three approved versioned artifacts | Met |
| 3.3 Model-free replay and outcomes | `src/replay/engine.ts`, `contract.ts`; success, not-found, restricted, recovery, hard-failure, and write-idempotency integration cases; post-failure operator resume never reissues a write | Met |
| 3.4 Allowlist, risk, redaction | `src/policy/`; origin/path and action checks, human gate for irreversible post, declared-value redaction including numeric API inputs | Met for synthetic demo; see limitation below |
| 3.5 Logs and failure evidence | `src/evidence/run-log.ts`; JSONL logs, persisted results for every engine status, screenshot and frame snapshot on browser failure | Met |
| 3.6 Human handoff | `src/escalation/`; same live page, explicit holder, operator API, action log, resume/abort, timeout | Met with minimal console and scripted operator |
| 3.7 Heterogeneity and tenant design | `src/surface/types.ts`, `web-playwright.ts`, `artifact/overlay.ts`, Harbor variant; desktop driver is documented as cut | Met at the requested design depth |
| 6. README, report, evidence | Root `README.md`, seven-heading short `REPORT.md`, `evidence/README.md`, example artifact, authentic discovery and replay records | Met locally |
| 11. Public repo and email | Public GitHub repository and email to `assignments@interface.ai` | GitHub publication pending; email is the applicant's final submission action |

## File pass

The source pass covers all 37 original TypeScript files across `src/`, `target-app/`, and `test/`, the two original Markdown files, configuration and lockfiles, three recorded artifacts, two authored specs, one tenant overlay, the generated JSON Schema, and every committed discovery, replay, escalation, HTML, and PNG evidence file. The current added Codex guidance, report archive, evidence index, artifact snapshot, and fresh failure runs were checked separately. `npm run catalog` parses the shipped artifacts, while `npm test` exercises the behavior they encode. New production changes were verified with failing tests before their fixes.

## Limits and decisions

- The target app and all evidence use synthetic account data. Screenshots and incidental page text cannot be safely redacted by exact-value matching alone; real financial data would require restricted evidence storage or a stronger capture boundary.
- Desktop automation, streamed co-browsing, durable queuing, tenant registry, and replay-time LLM recovery are outside the required vertical slice and documented in `REPORT.md`.
- Historical failure runs before the persistence fix have `run.jsonl` and rich failure evidence but no `result.json`. The fresh September 29 app-error and input-validation runs demonstrate that failures now persist the result contract.
- Discovery is coupled to the Anthropic API by design; the repository itself is usable from Codex through `AGENTS.md`, standard Node scripts, and a local `.env`. Replay and tests require no model key.
