import { z } from 'zod';
import type { InputParam } from '../artifact/schema.js';

/**
 * ============================================================================
 * The replay result contract
 * ============================================================================
 *
 * This is the interface the calling AI agent actually programs against, so it
 * is modelled before the engine that produces it.
 *
 * Three top-level statuses, because there are exactly three things that can
 * happen and conflating any two of them breaks the caller:
 *
 *   success          the flow completed and the declared outputs are populated.
 *
 *   business_outcome the application gave a legitimate answer that is not the
 *                    happy path: no such member, access denied, validation
 *                    rejected the input. The automation worked perfectly. The
 *                    caller needs this as DATA — it will phrase it to the
 *                    customer — and must never see it as an exception, or it
 *                    cannot tell "this member does not exist" from "our robot
 *                    is broken" and has to escalate both.
 *
 *   failure          the automation could not complete and nobody should
 *                    assume anything about the state of the application. The
 *                    caller's only sensible responses are retry or escalate,
 *                    and the payload carries what it needs to decide which.
 *
 * Recoverable conditions — a transient slow load, a maintenance interstitial, a
 * session that expired mid-run — are deliberately NOT a status. They are
 * handled inside the run and reported in `recoveries[]`. Surfacing them as a
 * status would push the retry decision onto a caller with less information than
 * the engine had. They stay visible, because a capability that silently
 * recovers five times a day is a capability that needs a fix.
 */

export type FailureCategory =
  /* --- the run never touched the application --- */
  /** Caller's inputs failed the declared schema. Their bug, cheap to report. */
  | 'input_validation'
  /** The capability is draft/deprecated, or policy refused before any action. */
  | 'policy_denied'

  /* --- the run touched the application and could not proceed --- */
  /** No locator strategy resolved the target. Usually genuine UI drift. */
  | 'locator_unresolved'
  /** The action itself threw: element detached, not editable, click intercepted. */
  | 'action_failed'
  /** The state required before a step did not hold. */
  | 'precondition_failed'
  /** The action ran but the expected resulting state never appeared. */
  | 'checkpoint_failed'
  /** Every step passed but the capability-level success condition did not. */
  | 'success_condition_failed'
  /** A bounded wait expired. */
  | 'timeout'
  /** The application returned an error page / 5xx. Not our bug, not a business answer. */
  | 'app_error'
  /** A recovery rule matched but could not fix the state within its attempts. */
  | 'recovery_exhausted'

  /* --- the human loop --- */
  | 'escalation_timeout'
  | 'operator_aborted'

  /** The deployment is missing something the capability declares it needs —
   * a credential, an env value. Our fault, but not a code defect, and the fix
   * is a config change rather than a bug report. */
  | 'configuration'

  /** A defect in this system. Distinguished so it is never mistaken for drift. */
  | 'internal';

/**
 * Whether the caller can sensibly try again. Encoded here rather than left to
 * the caller's judgement, because the engine knows things the caller does not:
 * a checkpoint failure after a write may have half-applied and must not be
 * blindly retried, while a transient timeout on a read is free to retry.
 */
export const RETRYABLE: Record<FailureCategory, boolean> = {
  input_validation: false,
  policy_denied: false,
  locator_unresolved: false,
  action_failed: true,
  precondition_failed: false,
  checkpoint_failed: false,
  success_condition_failed: false,
  timeout: true,
  app_error: true,
  recovery_exhausted: true,
  escalation_timeout: true,
  operator_aborted: false,
  configuration: false,
  internal: false,
};

export type FailureDetail = {
  category: FailureCategory;
  /** One line, safe to log and to show an operator. */
  message: string;
  stepId?: string;
  stepIntent?: string;
  stepIndex?: number;
  /** What the engine was asserting. */
  expected?: string;
  /** What it actually saw. The pair is what makes a failure debuggable. */
  observed?: string;
  url?: string;
  /** Per-strategy diagnosis when a locator failed. */
  locatorAttempts?: Array<{ strategyIndex: number; kind: string; matched: number; error?: string }>;
  retryable: boolean;
  evidence: { logPath: string; screenshotPath?: string; snapshotPath?: string };
};

export type RecoveryRecord = {
  stepId: string;
  ruleId: string;
  description: string;
  attempt: number;
  succeeded: boolean;
};

export type EscalationRecord = {
  ticketId: string;
  reason: string;
  stepId?: string;
  disposition?: string;
  operatorActions: number;
  waitedMs: number;
};

export type DriftRecord = {
  stepId: string;
  target: string;
  /** The tier the recording expected to use. */
  recordedTier: string;
  /** The tier that actually resolved. */
  resolvedTier: string;
  strategyIndex: number;
};

export type ReplayCommon = {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  tenantId?: string;
  startedAt: string;
  durationMs: number;
  stepsAttempted: number;
  stepsTotal: number;
  recoveries: RecoveryRecord[];
  escalations: EscalationRecord[];
  /**
   * Locator degradation observed during this run. Not an error — the point of a
   * ranked strategy list is that degradation is survivable — but the signal that
   * says a tenant's overlay needs attention before it becomes an outage.
   */
  drift: DriftRecord[];
  evidenceDir: string;
};

export type ReplayResult = ReplayCommon &
  (
    | { status: 'success'; outputs: Record<string, unknown> }
    | {
        status: 'business_outcome';
        outcome: { code: string; message: string };
        /** Whatever the capability declared as still-valid for this outcome. */
        outputs: Record<string, unknown>;
      }
    | { status: 'failure'; error: FailureDetail }
  );

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a Zod schema from the capability's declared inputs.
 *
 * Validating here means a malformed member ID is rejected in microseconds with
 * a precise message, instead of being typed into a bank screen and coming back
 * as an ambiguous validation banner ten seconds later. Only inputs the
 * capability could not have known about — a member that genuinely does not
 * exist — should reach the UI.
 */
export function inputSchema(params: InputParam[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of params) {
    let base: z.ZodTypeAny;
    switch (p.type) {
      case 'number':
      case 'money':
        base = z.coerce.number();
        break;
      case 'boolean':
        base = z.coerce.boolean();
        break;
      case 'date':
        base = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
        break;
      default: {
        let s = z.string();
        if (p.pattern) s = s.regex(new RegExp(p.pattern), `must match ${p.pattern}`);
        base = p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : s;
      }
    }
    if (p.default !== undefined) base = base.default(p.default as never);
    shape[p.name] = p.required && p.default === undefined ? base : base.optional();
  }
  // strict(): an unexpected parameter is a caller bug worth surfacing, not
  // something to silently drop into a banking transaction.
  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>;
}

/** Coerce an extracted string into the declared output type. */
export function coerceOutput(raw: string, type: string): unknown {
  switch (type) {
    case 'number':
      return Number(raw.replace(/[^0-9.\-]/g, ''));
    case 'money': {
      const neg = /^\s*[-(]/.test(raw) || raw.trim().startsWith('-$');
      const n = Number(raw.replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? (neg ? -n : n) : Number.NaN;
    }
    case 'boolean':
      return /^(true|yes|y|1)$/i.test(raw.trim());
    default:
      return raw.trim();
  }
}
