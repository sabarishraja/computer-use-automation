import type { Action, Capability, RiskClass } from '../artifact/schema.js';
import { riskRank } from '../artifact/schema.js';

/**
 * ============================================================================
 * Guardrails
 * ============================================================================
 *
 * The policy layer answers one question before every single action: "is the
 * system permitted to do this, right now, unattended?" It is deliberately a
 * pure function over (policy, action, context) so it can be unit-tested
 * exhaustively without a browser, and so the same decision is made identically
 * on the discovery path and the replay path.
 *
 * Three orthogonal checks:
 *   1. Navigation allowlist  — where the agent may go.
 *   2. Action-type allowlist — what verbs it may use at all.
 *   3. Risk gate             — whether this verb, on this step, may run without
 *                              a human saying yes.
 *
 * Deny is the default in all three.
 */

export type PolicyConfig = {
  /** Origin or origin+path prefixes. A URL must start with one of these. */
  allowedOrigins: string[];
  allowedPathPrefixes: string[];
  /** Verbs permitted at all. Anything absent is refused even if a step declares it. */
  allowedActionTypes: Action['type'][];
  /** Highest risk runnable without human confirmation. */
  maxUnattendedRisk: RiskClass;
  /**
   * Substrings that mark a control as irreversible regardless of what the
   * recorded step claims. A belt-and-braces check: a recording could
   * misclassify, but a button that says "Permanently" should never be pressed
   * unattended.
   */
  irreversibleHints: string[];
};

export const DEFAULT_ACTION_TYPES: Action['type'][] = ['navigate', 'click', 'fill', 'select', 'press', 'extract', 'waitFor', 'assert'];

export const DEFAULT_IRREVERSIBLE_HINTS = [
  'permanently',
  'delete',
  'close relationship',
  'purge',
  'wire',
  'post transaction',
  'confirm and post',
  'authorize payment',
  'charge off',
];

export type PolicyDecision =
  | { effect: 'allow' }
  | { effect: 'deny'; reason: string; code: PolicyDenyCode }
  | { effect: 'require_confirmation'; reason: string; code: PolicyDenyCode };

export type PolicyDenyCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'PATH_NOT_ALLOWED'
  | 'ACTION_TYPE_NOT_ALLOWED'
  | 'RISK_EXCEEDS_UNATTENDED'
  | 'IRREVERSIBLE_CONTROL';

export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  static fromCapability(cap: Capability, extra?: Partial<PolicyConfig>): PolicyEngine {
    return new PolicyEngine({
      allowedOrigins: cap.policy.allowedOrigins,
      allowedPathPrefixes: cap.policy.allowedPathPrefixes,
      allowedActionTypes: DEFAULT_ACTION_TYPES,
      maxUnattendedRisk: cap.policy.maxUnattendedRisk,
      irreversibleHints: DEFAULT_IRREVERSIBLE_HINTS,
      ...extra,
    });
  }

  get config(): PolicyConfig {
    return this.cfg;
  }

  checkUrl(url: string): PolicyDecision {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { effect: 'deny', reason: `not a valid absolute URL: ${url}`, code: 'ORIGIN_NOT_ALLOWED' };
    }
    const originOk = this.cfg.allowedOrigins.some((a) => u.origin === a || (u.origin + u.pathname).startsWith(a));
    if (!originOk) {
      return { effect: 'deny', reason: `origin ${u.origin} is not in the allowlist`, code: 'ORIGIN_NOT_ALLOWED' };
    }
    if (this.cfg.allowedPathPrefixes.length > 0) {
      const pathOk = this.cfg.allowedPathPrefixes.some((p) => u.pathname.startsWith(p));
      if (!pathOk) return { effect: 'deny', reason: `path ${u.pathname} is not in the allowlist`, code: 'PATH_NOT_ALLOWED' };
    }
    return { effect: 'allow' };
  }

  /**
   * @param label  the accessible name / visible text of the control being acted
   *               on, used for the irreversible-hint check.
   */
  checkAction(action: Action, risk: RiskClass, label?: string): PolicyDecision {
    if (!this.cfg.allowedActionTypes.includes(action.type)) {
      return { effect: 'deny', reason: `action type "${action.type}" is not permitted`, code: 'ACTION_TYPE_NOT_ALLOWED' };
    }
    if (action.type === 'navigate') {
      const d = this.checkUrl(action.url);
      if (d.effect !== 'allow') return d;
    }

    const hinted = label ? this.cfg.irreversibleHints.find((h) => label.toLowerCase().includes(h)) : undefined;
    const effectiveRisk: RiskClass = hinted ? 'write_irreversible' : risk;

    if (riskRank(effectiveRisk) > riskRank(this.cfg.maxUnattendedRisk)) {
      const why = hinted
        ? `control "${label}" matches irreversible hint "${hinted}"`
        : `step risk ${risk} exceeds maxUnattendedRisk ${this.cfg.maxUnattendedRisk}`;
      return {
        effect: 'require_confirmation',
        reason: why,
        code: hinted ? 'IRREVERSIBLE_CONTROL' : 'RISK_EXCEEDS_UNATTENDED',
      };
    }
    return { effect: 'allow' };
  }
}

/**
 * Why irreversible actions require confirmation rather than being blocked
 * outright:
 *
 * Blocking makes the system useless for the write flows that are most of the
 * business value ("open a sub-account"), and pushes operators back to doing the
 * whole task by hand. Requiring a human decision at exactly the irreversible
 * moment keeps the other twelve steps automated while putting the accountable
 * decision where a regulator would expect it. The confirmation reuses the
 * escalation channel, so there is one control-transfer mechanism, not two.
 *
 * The limit: this is a *policy* boundary, not a security boundary. A capability
 * that was recorded to do something harmful within the allowlist, using only
 * read-classified steps, would pass. Approval review of the artifact — which
 * the schema is designed to make readable — is the control for that, not this
 * engine.
 */
