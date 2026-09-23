import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Redactor } from '../policy/redaction.js';

/**
 * ============================================================================
 * Evidence
 * ============================================================================
 *
 * One directory per run under `evidence/runs/<runId>/`, containing:
 *
 *   run.jsonl     append-only structured event stream, redacted on write
 *   result.json   the structured result contract returned to the caller
 *   *.png         screenshots — captured at escalation and on failure
 *   *.html        frame snapshots — captured on failure
 *   transcript.json  discovery runs only: the redacted model exchange
 *
 * JSONL rather than a log library because the consumer here is a human doing a
 * post-mortem and a diff in a pull request, not a log aggregator. Every event
 * carries the step id, so "what did step 4 actually see" is one grep.
 *
 * Redaction happens at write time, not read time. There is no path by which an
 * unredacted value reaches disk, which is the only version of this property
 * that survives contact with a codebase that keeps growing.
 */

export type RunKind = 'discovery' | 'replay';

export type LogEvent =
  | { type: 'run.start'; kind: RunKind; goal?: string; capability?: string; tenant?: string; inputs?: Record<string, unknown> }
  | { type: 'observation'; url: string; title: string; controlCount: number; frames: number; screenshot?: string }
  | { type: 'model.turn'; index: number; toolName?: string; reasoning?: string; tokensIn?: number; tokensOut?: number }
  | { type: 'step.start'; stepId: string; intent: string; action: string; risk: string }
  | { type: 'policy.decision'; stepId?: string; effect: string; code?: string; reason?: string }
  | {
      type: 'locator.resolved';
      stepId: string;
      target: string;
      strategyIndex: number;
      strategyKind: string;
      tier: string;
      degraded: boolean;
    }
  | { type: 'locator.failed'; stepId: string; target: string; reason: string; attempts: unknown }
  | { type: 'action.performed'; stepId: string; action: string; ok: boolean; error?: string; ms: number }
  | { type: 'condition'; stepId?: string; role: 'precondition' | 'checkpoint' | 'success' | 'outcome' | 'recovery'; held: boolean; detail: string }
  | { type: 'outcome.detected'; code: string; message: string }
  | { type: 'recovery.applied'; stepId: string; ruleId: string; attempt: number; description: string }
  | { type: 'extract'; stepId: string; field: string; sensitivity: string; value: string }
  | { type: 'escalation.raised'; ticketId: string; reason: string; stepId?: string; screenshot?: string }
  | { type: 'control.transfer'; from: string; to: string; reason?: string }
  | { type: 'operator.action'; kind: string; target?: string; value?: string }
  | { type: 'escalation.resolved'; ticketId: string; disposition: string; operatorActions: number }
  | { type: 'run.end'; status: string; ms: number; error?: string };

export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private readonly file: string;
  private readonly started = Date.now();
  private seq = 0;

  constructor(
    root: string,
    readonly kind: RunKind,
    private readonly redactor: Redactor,
    runId?: string,
  ) {
    this.runId = runId ?? `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.dir = join(root, 'runs', this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, 'run.jsonl');
  }

  log(ev: LogEvent): void {
    const line = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      sinceStartMs: Date.now() - this.started,
      runId: this.runId,
      ...this.redactor.json(ev),
    };
    appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  /** Path for a screenshot tied to a step, so evidence files self-describe. */
  shotPath(label: string): string {
    return join(this.dir, `${String(this.seq).padStart(3, '0')}-${slug(label)}.png`);
  }

  snapPath(label: string): string {
    return join(this.dir, `${String(this.seq).padStart(3, '0')}-${slug(label)}.html`);
  }

  writeResult(result: unknown): string {
    const p = join(this.dir, 'result.json');
    writeFileSync(p, JSON.stringify(this.redactor.json(result), null, 2) + '\n', 'utf8');
    return p;
  }

  /**
   * A recording that failed validation, written where a reviewer can read the
   * steps the model actually produced instead of only the reason they were
   * refused. It is deliberately NOT written to the capability store: an invalid
   * artifact must never be loadable by replay.
   */
  writeRejectedCapability(capability: unknown): string {
    const p = join(this.dir, 'rejected-capability.json');
    writeFileSync(p, JSON.stringify(this.redactor.json(capability), null, 2) + '\n', 'utf8');
    return p;
  }

  /**
   * The transcript is stored redacted and separately from the artifact, and the
   * artifact keeps only its digest. A capability must be reviewable without
   * anyone re-reading model prose, and the transcript may contain page content
   * the artifact is not entitled to carry.
   */
  writeTranscript(transcript: unknown): { path: string; digest: string } {
    const redacted = JSON.stringify(this.redactor.json(transcript), null, 2);
    const p = join(this.dir, 'transcript.json');
    writeFileSync(p, redacted + '\n', 'utf8');
    return { path: p, digest: createHash('sha256').update(redacted).digest('hex') };
  }

  elapsedMs(): number {
    return Date.now() - this.started;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
}
