import type { OperatorAction } from '../surface/types.js';

/**
 * Why the automation stopped. This is a closed set on purpose: every escalation
 * a human sees is one of a handful of shapes, and the operator console can
 * therefore render a useful, specific screen for each rather than a generic
 * "something went wrong" with a stack trace.
 */
export type EscalationReason =
  /** Discovery: the model hit its step budget or looped without progress. */
  | 'discovery_stuck'
  /** Replay: a recorded target could not be found by any strategy. */
  | 'locator_unresolved'
  /** Replay: an unrecognised state — not a declared outcome, not a known recovery. */
  | 'unknown_state'
  /** Replay: a recovery rule exhausted its attempts. */
  | 'recovery_exhausted'
  /** Policy: an irreversible or over-risk step needs a human decision. */
  | 'confirmation_required'
  /** Replay/discovery: the app requires something the automation cannot supply. */
  | 'credential_required';

export type EscalationDisposition =
  /** The human did the manual steps; automation should continue from the current step. */
  | 'resume'
  /** The human did the manual steps AND completed the blocked step; skip it. */
  | 'resume_step_done'
  /** The human decided the run should stop. */
  | 'abort';

export type EscalationTicket = {
  ticketId: string;
  runId: string;
  createdAt: string;

  /* --- context: everything the operator needs to act without asking --- */
  capabilityId?: string;
  capabilityVersion?: string;
  tenantId?: string;
  goal?: string;
  stepId?: string;
  stepIntent?: string;
  stepIndex?: number;
  stepCount?: number;

  reason: EscalationReason;
  /** Redacted, human-readable explanation of what stopped and what was observed. */
  detail: string;
  /** What the operator is being asked to do. */
  askedOf: string;
  url: string;
  /** Relative path, inside the run's evidence directory. */
  screenshot?: string;

  status: 'open' | 'claimed' | 'resolved';
  claimedBy?: string;
  claimedAt?: string;
  resolvedAt?: string;
  disposition?: EscalationDisposition;
  operatorNotes?: string;
  operatorActions: OperatorAction[];

  /** How a human tool can attach to the live session directly. */
  sessionEndpoint?: string;
};

export type Resolution = {
  disposition: EscalationDisposition;
  notes?: string;
  operatorActions: OperatorAction[];
};
