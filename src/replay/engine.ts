import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import {
  renderTemplate,
  TemplateResolutionError,
  type Action,
  type Capability,
  type Condition,
  type Locator,
  type RecoveryRule,
  type Step,
} from '../artifact/schema.js';
import { resolveForTenant } from '../artifact/overlay.js';
import { WebSurface } from '../surface/web-playwright.js';
import type { PerformableAction, ResolvedTarget } from '../surface/types.js';
import { PolicyEngine } from '../policy/guardrails.js';
import { Redactor } from '../policy/redaction.js';
import { RunLogger } from '../evidence/run-log.js';
import { EscalationBroker } from '../escalation/broker.js';
import { SessionController } from '../escalation/session-control.js';
import type { EscalationReason, Resolution } from '../escalation/types.js';
import {
  coerceOutput,
  inputSchema,
  mayReissueAfterHandoff,
  type DriftRecord,
  type EscalationRecord,
  type FailureCategory,
  type FailureDetail,
  type RecoveryRecord,
  type ReplayResult,
  retryableFor,
} from './contract.js';

export type ReplayOptions = {
  capability: Capability;
  inputs: Record<string, unknown>;
  tenantId?: string;
  /** `{{env.x}}` values. Keys prefixed `secret_` are registered as secrets. */
  env?: Record<string, string>;
  headless?: boolean;
  evidenceRoot: string;
  /** Replay a draft capability. Off by default: unattended replay needs review. */
  allowDraft?: boolean;
  escalation?: {
    broker: EscalationBroker;
    consoleBaseUrl: string;
    /** How long to wait for a human before failing the run. */
    timeoutMs: number;
    remoteDebuggingPort?: number;
  };
  /** Pre-seeded run id, so a caller can correlate before the run finishes. */
  runId?: string;
};

/**
 * ============================================================================
 * Deterministic replay
 * ============================================================================
 *
 * No model is consulted. Every decision the engine makes comes from the
 * artifact: which control to act on, what state must hold before and after,
 * which interruptions are known and how to clear them, and which page contents
 * mean "the app answered, just not with what you hoped".
 *
 * Determinism here rests on four things, in order of how much work they do:
 *
 *  1. Ranked, semantic-first locators. No coordinates, no recorded DOM paths as
 *     the primary handle, no "the third button".
 *  2. Condition-based waiting. Every wait is "until this declared condition
 *     holds, or this deadline passes". There is not one fixed sleep in the
 *     replay path, so a slow tenant is slow rather than flaky.
 *  3. Checkpoints after every state-changing step. A click that did nothing is
 *     caught immediately, at the step that caused it, rather than surfacing
 *     three steps later as an inexplicable locator failure.
 *  4. Declared outcomes checked after every action. The app is allowed to
 *     change the subject — that is what a "record not found" banner is — and
 *     the engine notices at the moment it happens.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = opts.runId ?? `replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  const redactor = new Redactor(runId);
  const logger = new RunLogger(opts.evidenceRoot, 'replay', redactor, runId);

  const cap = opts.tenantId ? resolveForTenant(opts.capability, opts.tenantId) : opts.capability;
  const recoveries: RecoveryRecord[] = [];
  const escalations: EscalationRecord[] = [];
  const drift: DriftRecord[] = [];

  const common = () => ({
    runId,
    capabilityId: cap.id,
    capabilityVersion: cap.version,
    tenantId: opts.tenantId,
    startedAt,
    durationMs: Date.now() - t0,
    stepsAttempted,
    stepsTotal: cap.steps.length,
    recoveries,
    escalations,
    drift,
    evidenceDir: logger.dir,
  });

  let stepsAttempted = 0;

  const failNow = (category: FailureCategory, detail: Omit<FailureDetail, 'category' | 'retryable' | 'evidence'>): ReplayResult => {
    logger.log({ type: 'run.end', status: 'failure:' + category, ms: Date.now() - t0, error: detail.message });
    const result: ReplayResult = {
      ...common(),
      status: 'failure',
      error: {
        ...detail,
        category,
        retryable: retryableFor(category),
        evidence: { logPath: logger.path('run.jsonl') },
      },
    };
    logger.writeResult(result);
    return result;
  };

  /* ---------------------- pre-flight, before any browser ------------------ */

  // Registration must precede the FIRST log line, not merely the first action:
  // `run.start` echoes the caller's inputs, and a redactor that learns about
  // them one line later has already leaked them.
  for (const p of cap.inputs) {
    if (p.name in opts.inputs) redactor.register(opts.inputs[p.name], p.sensitivity);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) if (k.startsWith('secret_')) redactor.register(v, 'secret');

  logger.log({
    type: 'run.start',
    kind: 'replay',
    capability: `${cap.id}@${cap.version}`,
    tenant: opts.tenantId,
    inputs: opts.inputs,
  });

  // `requiresApprovalState` is the artifact's own declaration of which states
  // it may run in. It used to be quoted in the error message below while the
  // engine hardcoded the rule — a field that read as enforced and was not.
  if (!cap.policy.requiresApprovalState.includes(cap.state) && !(cap.state === 'draft' && opts.allowDraft)) {
    return failNow('policy_denied', {
      message:
        cap.state === 'draft'
          ? `capability ${cap.id}@${cap.version} is in state "draft"; unattended replay requires review and approval`
          : `capability ${cap.id}@${cap.version} is in state "${cap.state}", which it does not permit for replay`,
      expected: `state in ${JSON.stringify(cap.policy.requiresApprovalState)}`,
      observed: cap.state,
    });
  }

  const parsedInputs = inputSchema(cap.inputs).safeParse(opts.inputs);
  if (!parsedInputs.success) {
    const issues = parsedInputs.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return failNow('input_validation', {
      message: `inputs rejected by the capability contract: ${issues}`,
      expected: cap.inputs.map((i) => `${i.name}:${i.type}${i.required ? '' : '?'}`).join(', '),
      observed: JSON.stringify(Object.keys(opts.inputs)),
    });
  }
  const inputs = parsedInputs.data;

  // Re-register post-coercion values too: a number input arrives as 1000 and
  // is typed as "1000", and both spellings must be scrubbed.
  for (const p of cap.inputs) if (p.name in inputs) redactor.register(inputs[p.name], p.sensitivity);
  const env: Record<string, string> = { ...(opts.env ?? {}) };

  const policy = PolicyEngine.fromCapability(cap);

  /* ------------------------------- browser -------------------------------- */

  let surface: WebSurface;
  try {
    surface = await WebSurface.launch({
      headless: opts.headless ?? true,
      viewport: cap.surface.viewport,
      allowedOrigins: cap.policy.allowedOrigins,
      remoteDebuggingPort: opts.escalation?.remoteDebuggingPort,
    });
  } catch (e) {
    return failNow('internal', { message: `could not start the surface: ${(e as Error).message}` });
  }

  const session = new SessionController(
    surface,
    runId,
    opts.escalation?.consoleBaseUrl ?? 'http://127.0.0.1:0',
    opts.escalation?.remoteDebuggingPort ? `http://127.0.0.1:${opts.escalation.remoteDebuggingPort}` : 'in-process',
    (from, to, reason) => logger.log({ type: 'control.transfer', from, to, reason }),
  );
  opts.escalation?.broker.registerSession(runId, session);

  const outputs: Record<string, unknown> = {};
  const recoveryAttempts = new Map<string, number>();

  /* ------------------------------ helpers --------------------------------- */

  const render = (tmpl: string): string => renderTemplate(tmpl, { inputs, outputs, env });

  /**
   * Conditions are otherwise static by design — a checkpoint containing a value
   * from one run would only ever hold for that run. An idempotency guard is the
   * exception: "already has a {{inputs.accountType}} account" is a question
   * about the caller's request, so its text is rendered.
   */
  const renderCondition = (c: Condition): Condition =>
    c.kind === 'textPresent' || c.kind === 'textAbsent' ? { ...c, value: render(c.value) } : c;

  const captureFailureEvidence = async (label: string) => {
    const shot = await surface.screenshot(logger.shotPath(label));
    const snap = await surface.snapshot(logger.snapPath(label));
    logger.redactFileInPlace(snap);
    return {
      screenshotPath: shot ? relative(process.cwd(), shot) : undefined,
      snapshotPath: snap ? relative(process.cwd(), snap) : undefined,
    };
  };

  const fail = async (
    category: FailureCategory,
    detail: Omit<FailureDetail, 'category' | 'retryable' | 'evidence'>,
  ): Promise<ReplayResult> => {
    const ev = await captureFailureEvidence(`${category}-${detail.stepId ?? 'run'}`);
    logger.log({ type: 'run.end', status: 'failure:' + category, ms: Date.now() - t0, error: detail.message });
    const result: ReplayResult = {
      ...common(),
      status: 'failure',
      error: {
        ...detail,
        category,
        retryable: retryableFor(category, cap.steps.find((step) => step.id === detail.stepId)?.risk),
        url: detail.url ?? (await surface.currentUrl()),
        evidence: { logPath: logger.path('run.jsonl'), ...ev },
      },
    };
    logger.writeResult(result);
    return result;
  };

  /** Check every declared business outcome. First match wins and ends the run. */
  const checkOutcomes = async (): Promise<{ code: string; message: string; partialOutputs: string[] } | null> => {
    for (const oc of cap.outcomes) {
      const r = await surface.evaluate(oc.when, 0);
      if (r.held) {
        logger.log({ type: 'condition', role: 'outcome', held: true, detail: `${oc.code}: ${r.detail}` });
        let message = oc.message;
        try {
          message = render(oc.message);
        } catch {
          /* a message template referencing an unset output is not worth failing over */
        }
        return { code: oc.code, message, partialOutputs: oc.partialOutputs };
      }
    }
    return null;
  };

  const rulesFor = (step: Step): RecoveryRule[] => [...step.recovery, ...cap.globalRecovery];

  /**
   * Has recovery for this step given up? Either a rule burned its attempts, or
   * a rule ran and its own trigger still held afterwards. Both mean the state
   * was never repaired, and the failure belongs to recovery rather than to
   * whatever the run tripped over next.
   */
  const recoveryGaveUp = (step: Step): boolean =>
    rulesFor(step).some((r) => (recoveryAttempts.get(`${step.id}:${r.id}`) ?? 0) >= r.maxAttempts) ||
    recoveries.some((r) => r.stepId === step.id && !r.succeeded);

  /**
   * Try each applicable recovery rule whose trigger currently holds.
   * Bounded twice over: by `maxAttempts` per rule and by the fixed action list
   * the rule declares. Recovery can never become an improvising agent.
   */
  const tryRecover = async (step: Step): Promise<boolean> => {
    for (const rule of rulesFor(step)) {
      const key = `${step.id}:${rule.id}`;
      const used = recoveryAttempts.get(key) ?? 0;
      if (used >= rule.maxAttempts) continue;
      const trig = await surface.evaluate(rule.when, 0);
      if (!trig.held) continue;

      recoveryAttempts.set(key, used + 1);
      logger.log({ type: 'recovery.applied', stepId: step.id, ruleId: rule.id, attempt: used + 1, description: rule.description });

      let ok = true;
      for (const a of rule.do) {
        const r = await runAction(step, a, 15_000);
        if (!r.ok) {
          ok = false;
          break;
        }
      }

      // Running the actions is not the same as fixing the state. A "Continue"
      // button that reloads the same maintenance notice used to count as a
      // recovery, so a condition that never cleared was reported as repaired
      // and the run then failed somewhere else with an unrelated category.
      // The rule's own trigger is the test of whether it worked.
      if (ok) {
        const still = await surface.evaluate(rule.when, 0);
        if (still.held) {
          ok = false;
          logger.log({
            type: 'recovery.applied',
            stepId: step.id,
            ruleId: rule.id,
            attempt: used + 1,
            description: `${rule.description} — trigger still holds afterwards, so this did not recover anything`,
          });
        }
      }

      recoveries.push({ stepId: step.id, ruleId: rule.id, description: rule.description, attempt: used + 1, succeeded: ok });
      if (ok) return true;
    }
    return false;
  };

  const resolveTarget = async (
    step: Step,
    loc: Locator,
    timeoutMs: number,
  ): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; detail: FailureDetail['locatorAttempts']; reason: string }> => {
    const r = await surface.resolve(loc, timeoutMs);
    if (r.ok) {
      const degraded = r.target.strategyIndex > 0;
      logger.log({
        type: 'locator.resolved',
        stepId: step.id,
        target: loc.description,
        strategyIndex: r.target.strategyIndex,
        strategyKind: r.target.strategy.kind,
        tier: r.target.strategy.tier,
        degraded,
      });
      if (degraded) {
        drift.push({
          stepId: step.id,
          target: loc.description,
          recordedTier: loc.strategies[0]?.tier ?? 'unknown',
          resolvedTier: r.target.strategy.tier,
          strategyIndex: r.target.strategyIndex,
        });
      }
      return { ok: true, target: r.target };
    }
    logger.log({ type: 'locator.failed', stepId: step.id, target: loc.description, reason: r.failure.reason, attempts: r.failure.attempts });
    return { ok: false, detail: r.failure.attempts, reason: r.failure.reason };
  };

  /** Execute one artifact action. Used by steps and by recovery rules alike. */
  const runAction = async (step: Step, action: Action, timeoutMs: number): Promise<{ ok: boolean; error?: string }> => {
    session.assertHolder('automation');
    const started = Date.now();

    if (action.type === 'waitFor') {
      const r = await surface.evaluate(action.condition, timeoutMs);
      logger.log({ type: 'condition', stepId: step.id, role: 'precondition', held: r.held, detail: r.detail });
      return { ok: r.held, error: r.held ? undefined : `wait condition never held: ${r.detail}` };
    }
    if (action.type === 'assert') {
      const r = await surface.evaluate(action.condition, timeoutMs);
      logger.log({ type: 'condition', stepId: step.id, role: 'checkpoint', held: r.held, detail: r.detail });
      return { ok: r.held, error: r.held ? undefined : `assertion failed: ${r.detail}` };
    }

    let perf: PerformableAction;
    if (action.type === 'navigate') {
      perf = { type: 'navigate', url: render(action.url) };
    } else if (action.type === 'press' && !action.target) {
      perf = { type: 'press', key: action.key };
    } else {
      const loc = (action as { target: Locator }).target;
      const res = await resolveTarget(step, loc, timeoutMs);
      if (!res.ok) return { ok: false, error: `could not resolve "${loc.description}" (${res.reason})` };
      switch (action.type) {
        case 'click':
          perf = { type: 'click', target: res.target };
          break;
        case 'fill':
          perf = { type: 'fill', target: res.target, value: render(action.value) };
          break;
        case 'select':
          perf = { type: 'select', target: res.target, value: render(action.value) };
          break;
        case 'press':
          perf = { type: 'press', key: action.key, target: res.target };
          break;
        case 'extract':
          perf = { type: 'readText', target: res.target };
          break;
        default:
          return { ok: false, error: `unsupported action ${(action as Action).type}` };
      }
    }

    const r = await surface.perform(perf, timeoutMs);
    logger.log({ type: 'action.performed', stepId: step.id, action: action.type, ok: r.ok, error: r.ok ? undefined : r.error, ms: Date.now() - started });
    if (!r.ok) return { ok: false, error: r.error };

    if (action.type === 'extract') {
      const field = cap.outputs.find((o) => o.name === action.field);
      const rawText = r.text ?? '';
      const transformed = applyTransform(rawText, action.transform);
      const value = coerceOutput(transformed, field?.type ?? 'string');
      outputs[action.field] = value;
      if (field) redactor.register(String(value), field.sensitivity);
      logger.log({
        type: 'extract',
        stepId: step.id,
        field: action.field,
        sensitivity: field?.sensitivity ?? 'public',
        value: String(value),
      });
    }
    return { ok: true };
  };

  const escalate = async (
    reason: EscalationReason,
    detail: string,
    askedOf: string,
    step?: Step,
    stepIndex?: number,
  ): Promise<Resolution | { aborted: true; why: string }> => {
    if (!opts.escalation) {
      return { aborted: true, why: 'escalation is not configured for this run' };
    }
    const shot = await surface.screenshot(logger.shotPath(`escalation-${step?.id ?? reason}`));
    const access = await session.cedeToOperator(reason);
    const waitStart = Date.now();
    try {
      const ticketInput = {
        runId,
        capabilityId: cap.id,
        capabilityVersion: cap.version,
        tenantId: opts.tenantId,
        stepId: step?.id,
        stepIntent: step?.intent,
        stepIndex: stepIndex !== undefined ? stepIndex + 1 : undefined,
        stepCount: cap.steps.length,
        reason,
        detail,
        askedOf,
        url: await surface.currentUrl(),
        screenshot: shot ? relative(logger.dir, shot) : undefined,
        sessionEndpoint: access.endpoint,
      };
      logger.log({ type: 'escalation.raised', ticketId: '(pending)', reason, stepId: step?.id, screenshot: ticketInput.screenshot });
      const resolution = await opts.escalation.broker.raise(ticketInput, opts.escalation.timeoutMs);
      const open = opts.escalation.broker.list().find((t) => t.runId === runId && t.disposition === resolution.disposition);
      escalations.push({
        ticketId: open?.ticketId ?? 'unknown',
        reason,
        stepId: step?.id,
        disposition: resolution.disposition,
        operatorActions: resolution.operatorActions.length,
        waitedMs: Date.now() - waitStart,
      });
      logger.log({
        type: 'escalation.resolved',
        ticketId: open?.ticketId ?? 'unknown',
        disposition: resolution.disposition,
        operatorActions: resolution.operatorActions.length,
      });
      for (const a of resolution.operatorActions) {
        logger.log({ type: 'operator.action', kind: a.kind, target: a.target, value: a.value });
      }
      await session.reclaim();
      return resolution;
    } catch (e) {
      session.abandon('escalation failed');
      return { aborted: true, why: (e as Error).message };
    }
  };

  /* --------------------------------- run ---------------------------------- */

  try {
    for (const [index, step] of cap.steps.entries()) {
      stepsAttempted = index + 1;
      surface.beginScope();
      logger.log({ type: 'step.start', stepId: step.id, intent: step.intent, action: step.action.type, risk: step.risk });

      /* -- policy, before anything is touched -- *
       * The allowlist is checked against the RENDERED url. Checking the
       * template would compare "{{env.baseUrl}}/..." against the allowlist and
       * refuse every parameterised navigation — and, worse, a check that
       * passed on a template would say nothing about where the run actually
       * goes.                                                                */
      const label = 'target' in step.action && step.action.target ? (step.action.target as Locator).description : undefined;
      let actionForPolicy: Action = step.action;
      if (step.action.type === 'navigate') {
        try {
          actionForPolicy = { type: 'navigate', url: render(step.action.url) };
        } catch (e) {
          return await fail('internal', {
            message: `step "${step.id}" has an unresolvable url template: ${(e as Error).message}`,
            stepId: step.id,
            stepIntent: step.intent,
            stepIndex: index + 1,
          });
        }
      }
      const decision = policy.checkAction(actionForPolicy, step.risk, label);
      logger.log({
        type: 'policy.decision',
        stepId: step.id,
        effect: decision.effect,
        code: 'code' in decision ? decision.code : undefined,
        reason: 'reason' in decision ? decision.reason : undefined,
      });

      let stepAlreadyDone = false;

      if (decision.effect === 'deny') {
        return await fail('policy_denied', {
          message: `policy refused step "${step.id}": ${decision.reason}`,
          stepId: step.id,
          stepIntent: step.intent,
          stepIndex: index + 1,
          expected: 'an action permitted by the capability policy',
          observed: decision.code,
        });
      }

      if (decision.effect === 'require_confirmation') {
        const res = await escalate(
          'confirmation_required',
          `Step ${index + 1}/${cap.steps.length} "${step.intent}" is classified ${step.risk} and needs a human decision. Reason: ${decision.reason}.`,
          `Review the screen, then release with "resume" to let the automation perform this step, "mark step done" if you performed it yourself, or "abort".`,
          step,
          index,
        );
        if ('aborted' in res) {
          return await fail(res.why.startsWith('ESCALATION_TIMEOUT') ? 'escalation_timeout' : 'policy_denied', {
            message: `confirmation required for step "${step.id}" but not obtained: ${res.why}`,
            stepId: step.id,
            stepIntent: step.intent,
            stepIndex: index + 1,
          });
        }
        if (res.disposition === 'abort') {
          return await fail('operator_aborted', {
            message: `operator aborted the run at step "${step.id}"`,
            stepId: step.id,
            stepIntent: step.intent,
            stepIndex: index + 1,
            observed: res.notes,
          });
        }
        if (res.disposition === 'resume_step_done') stepAlreadyDone = true;
      }

      /* -- idempotency: has this write already been applied? -- */
      if (step.idempotency && !stepAlreadyDone) {
        // Evaluated on the screen BEFORE the step acts, with the caller's own
        // values rendered in, so "does this member already have a VACATION
        // CLUB account" is a question about this call and not about the
        // recording. A held guard is not a failure: the work exists, and
        // saying so is a business answer.
        const guard = renderCondition(step.idempotency.guard);
        const key = render(step.idempotency.key);
        const already = await surface.evaluate(guard, 0);
        logger.log({
          type: 'idempotency',
          stepId: step.id,
          key,
          alreadyApplied: already.held,
          detail: already.detail,
        });
        if (already.held) {
          const declared = cap.outcomes.find((o) => o.code === step.idempotency?.outcome);
          if (declared) {
            return finishWithOutcome({
              code: declared.code,
              message: render(declared.message),
              partialOutputs: declared.partialOutputs,
            });
          }
          // Declared outcome missing is a validation error, not something to
          // paper over by writing twice.
          return await fail('internal', {
            message: `step "${step.id}" idempotency names outcome "${step.idempotency.outcome}", which the capability does not declare`,
            stepId: step.id,
          });
        }
      }

      /* -- precondition -- */
      if (step.precondition && !stepAlreadyDone) {
        let pre = await surface.evaluate(step.precondition, Math.min(step.timeoutMs, 5000));
        logger.log({ type: 'condition', stepId: step.id, role: 'precondition', held: pre.held, detail: pre.detail });
        if (!pre.held) {
          const outcome = await checkOutcomes();
          if (outcome) return finishWithOutcome(outcome);
          if (await tryRecover(step)) {
            pre = await surface.evaluate(step.precondition, Math.min(step.timeoutMs, 5000));
          }
          if (!pre.held) {
            return await fail('precondition_failed', {
              message: `precondition for step "${step.id}" did not hold`,
              stepId: step.id,
              stepIntent: step.intent,
              stepIndex: index + 1,
              expected: describe(step.precondition),
              observed: pre.detail,
            });
          }
        }
      }

      /* -- action, with one bounded recovery retry -- */
      surface.setDialogPolicy(step.dialog);
      if (!stepAlreadyDone) {
        let result = await runAction(step, step.action, step.timeoutMs);

        if (!result.ok) {
          const outcome = await checkOutcomes();
          if (outcome) return finishWithOutcome(outcome);

          if (await tryRecover(step)) {
            if (step.risk === 'read') {
              result = await runAction(step, step.action, step.timeoutMs);
            } else if (step.checkpoint && (await surface.evaluate(step.checkpoint, 0)).held) {
              // A write may have landed despite an action error. Verify it,
              // but never issue it again automatically after recovery.
              result = { ok: true };
            }
          }
        }

        if (!result.ok) {
          // Last resort before failing: ask a human, if one is available.
          const isLocator = (result.error ?? '').startsWith('could not resolve');
          // A control that is missing because a recovery rule could not clear
          // the screen in front of it is not UI drift. Attributing it to the
          // locator sends an engineer hunting for a renamed field while the
          // application is sitting on a maintenance notice.
          const recoveryStuck = recoveryGaveUp(step);
          const res = await escalate(
            isLocator ? 'locator_unresolved' : 'unknown_state',
            `Step ${index + 1}/${cap.steps.length} "${step.intent}" could not be performed. ${result.error}`,
            `Bring the application to the state this step expects (${describe(step.checkpoint ?? { kind: 'textPresent', value: '?' })}), then release with "mark step done"; "resume" ${step.risk === 'read' ? 'retries the read' : 'only rechecks the state and will never repeat this write'}; or abort.`,
            step,
            index,
          );
          if ('aborted' in res) {
            return await fail(recoveryStuck ? 'recovery_exhausted' : isLocator ? 'locator_unresolved' : 'action_failed', {
              message: result.error ?? 'action failed',
              stepId: step.id,
              stepIntent: step.intent,
              stepIndex: index + 1,
              expected: label ? `a single control matching "${label}"` : step.action.type,
              observed: res.why === 'escalation is not configured for this run' ? (result.error ?? '') : `${result.error}; escalation: ${res.why}`,
            });
          }
          if (res.disposition === 'abort') {
            return await fail('operator_aborted', {
              message: `operator aborted the run at step "${step.id}"`,
              stepId: step.id,
              stepIntent: step.intent,
              stepIndex: index + 1,
            });
          }
          if (mayReissueAfterHandoff(step.risk, res.disposition)) {
            result = await runAction(step, step.action, step.timeoutMs);
            if (!result.ok && !step.optional) {
              return await fail('action_failed', {
                message: `step "${step.id}" still failed after operator intervention: ${result.error}`,
                stepId: step.id,
                stepIntent: step.intent,
                stepIndex: index + 1,
              });
            }
          } else if (res.disposition === 'resume' && step.risk !== 'read') {
            const verified = step.checkpoint && (await surface.evaluate(step.checkpoint, 0)).held;
            if (!verified) {
              return await fail('action_failed', {
                message: `step "${step.id}" may have written data; operator resume did not verify its checkpoint, so the write was not repeated`,
                stepId: step.id,
                stepIntent: step.intent,
                stepIndex: index + 1,
                expected: step.checkpoint ? describe(step.checkpoint) : 'a declared checkpoint for the write',
                observed: result.error,
              });
            }
          }
          // resume_step_done falls through to the checkpoint, which is the
          // honest way to verify what the human claims to have done.
        }
      }

      /* -- business outcome, checked before the checkpoint -- *
       * Order matters. "No member record found" makes the detail-page
       * checkpoint fail, and reporting that as a checkpoint failure would turn
       * a legitimate answer into a fake outage. The outcome check runs first so
       * the app gets to speak before we call anything broken.                 */
      const outcome = await checkOutcomes();
      if (outcome) return finishWithOutcome(outcome);

      /* -- checkpoint -- */
      if (step.checkpoint) {
        let cp = await surface.evaluate(step.checkpoint, step.timeoutMs);
        logger.log({ type: 'condition', stepId: step.id, role: 'checkpoint', held: cp.held, detail: cp.detail });

        if (!cp.held) {
          const late = await checkOutcomes();
          if (late) return finishWithOutcome(late);

          if (await tryRecover(step)) {
            // Re-check before redoing anything: recovery often lands exactly
            // where the step was trying to get to (re-authentication returns
            // to the requested screen), and redoing the action would then act
            // on a control that no longer exists.
            cp = await surface.evaluate(step.checkpoint, step.timeoutMs);
            logger.log({ type: 'condition', stepId: step.id, role: 'checkpoint', held: cp.held, detail: cp.detail + ' (after recovery)' });

            // Only a read-classified step may be replayed automatically. Redoing
            // a write could double-post, and no recovery rule is worth that.
            if (!cp.held && !stepAlreadyDone && step.risk === 'read') {
              await runAction(step, step.action, step.timeoutMs);
              cp = await surface.evaluate(step.checkpoint, step.timeoutMs);
              logger.log({ type: 'condition', stepId: step.id, role: 'checkpoint', held: cp.held, detail: cp.detail + ' (after recovery and retry)' });
            }
          }
        }

        /* -- the app is in a state we do not recognise: ask a human -- *
         * This is the escalation that matters most in production. It is not a
         * bug and not a business outcome: the application has shown something
         * the capability was never taught, and the only safe options are a
         * human or a clean stop.                                             */
        if (!cp.held && !step.optional && opts.escalation) {
          const res = await escalate(
            'unknown_state',
            `Step ${index + 1}/${cap.steps.length} "${step.intent}" ran, but the expected state did not appear.\n` +
              `Expected: ${describe(step.checkpoint)}\nObserved: ${cp.detail}`,
            `Look at the screen. If the application is asking for something the automation cannot supply, do it yourself and release with "mark step done". "Resume" ${step.risk === 'read' ? 'retries the read step' : 'only rechecks the state and will never repeat this write'}; or abort.`,
            step,
            index,
          );
          if (!('aborted' in res)) {
            if (res.disposition === 'abort') {
              return await fail('operator_aborted', {
                message: `operator aborted the run at step "${step.id}"`,
                stepId: step.id,
                stepIntent: step.intent,
                stepIndex: index + 1,
                observed: res.notes,
              });
            }
            if (mayReissueAfterHandoff(step.risk, res.disposition)) await runAction(step, step.action, step.timeoutMs);
            // Whatever the operator says they did, the checkpoint is what
            // decides. A human claiming "done" does not skip verification.
            cp = await surface.evaluate(step.checkpoint, step.timeoutMs);
            logger.log({ type: 'condition', stepId: step.id, role: 'checkpoint', held: cp.held, detail: cp.detail + ' (after operator intervention)' });
          } else if (res.why.startsWith('ESCALATION_TIMEOUT')) {
            return await fail('escalation_timeout', {
              message: `step "${step.id}" needed a human and none responded`,
              stepId: step.id,
              stepIntent: step.intent,
              stepIndex: index + 1,
              expected: describe(step.checkpoint),
              observed: cp.detail,
            });
          }
        }

        if (!cp.held && !step.optional) {
          // An application error page is its own category. Reporting a 500 as
          // "checkpoint_failed" would send an on-call engineer looking for UI
          // drift when the application itself is down.
          // A dismissed confirm() is the commonest reason a click "did nothing".
          // Saying so turns an afternoon of locator archaeology into a one-line
          // artifact change.
          const dismissed = surface.dialogsSeen().filter((d) => d.answered === 'dismissed');
          const appErr = await surface.evaluate({ kind: 'httpStatusAtLeast', status: 500 }, 0);
          const exhausted = recoveryGaveUp(step);
          const category = appErr.held ? 'app_error' : exhausted ? 'recovery_exhausted' : 'checkpoint_failed';
          return await fail(category, {
            message:
              dismissed.length > 0
                ? `step "${step.id}" (${step.intent}) did not reach its expected state: the application raised a dialog ` +
                  `(${JSON.stringify(dismissed[0]!.message)}) and it was dismissed. If this step should answer it, ` +
                  `declare "dialog": "accept" on the step.`
                : `step "${step.id}" (${step.intent}) did not reach its expected state`,
            stepId: step.id,
            stepIntent: step.intent,
            stepIndex: index + 1,
            expected: describe(step.checkpoint),
            observed: dismissed.length > 0 ? `${cp.detail}; dialog dismissed: ${dismissed[0]!.message}` : cp.detail,
          });
        }
      }
    }

    /* -- capability-level success condition -- */
    const success = await surface.evaluate(cap.successCondition, 8000);
    logger.log({ type: 'condition', role: 'success', held: success.held, detail: success.detail });
    if (!success.held) {
      return await fail('success_condition_failed', {
        message: `all steps ran but the capability success condition did not hold`,
        expected: describe(cap.successCondition),
        observed: success.detail,
      });
    }

    const missing = cap.outputs.filter((o) => o.required && outputs[o.name] === undefined).map((o) => o.name);
    if (missing.length > 0) {
      return await fail('success_condition_failed', {
        message: `required outputs were not extracted: ${missing.join(', ')}`,
        expected: cap.outputs.map((o) => o.name).join(', '),
        observed: Object.keys(outputs).join(', ') || '(none)',
      });
    }

    const { forCaller, forEvidence } = redactor.partitionOutputs(outputs, cap.outputs, cap.policy.neverPersist);
    logger.log({ type: 'run.end', status: 'success', ms: Date.now() - t0 });
    const result: ReplayResult = { ...common(), status: 'success', outputs: forCaller };
    logger.writeResult({ ...result, outputs: forEvidence });
    return result;
  } catch (e) {
    // A missing credential or env value is a deployment problem, not a defect
    // in this engine, and a caller must be able to tell those apart.
    if (e instanceof TemplateResolutionError) {
      return await fail('configuration', {
        message: `${e.message}. Set it in the environment (see .env.example) before replaying this capability.`,
      });
    }
    return await fail('internal', { message: `unhandled error in the replay engine: ${(e as Error).message}` });
  } finally {
    await surface.close();
  }

  function finishWithOutcome(oc: { code: string; message: string; partialOutputs: string[] }): ReplayResult {
    logger.log({ type: 'outcome.detected', code: oc.code, message: oc.message });
    logger.log({ type: 'run.end', status: 'business_outcome:' + oc.code, ms: Date.now() - t0 });
    const kept: Record<string, unknown> = {};
    for (const name of oc.partialOutputs) if (outputs[name] !== undefined) kept[name] = outputs[name];
    const { forCaller, forEvidence } = redactor.partitionOutputs(kept, cap.outputs, cap.policy.neverPersist);
    const result: ReplayResult = {
      ...common(),
      status: 'business_outcome',
      outcome: { code: oc.code, message: oc.message },
      outputs: forCaller,
    };
    logger.writeResult({ ...result, outputs: forEvidence });
    return result;
  }
}

function applyTransform(raw: string, t: Extract<Action, { type: 'extract' }>['transform']): string {
  if (!t) return raw.trim();
  switch (t.kind) {
    case 'trim':
      return raw.trim();
    case 'money':
    case 'number':
      return raw.trim();
    case 'regex': {
      const m = new RegExp(t.pattern).exec(raw);
      return m?.[t.group] ?? '';
    }
  }
}

/** Render a condition as the one-line "expected" half of a failure report. */
export function describe(c: Condition): string {
  switch (c.kind) {
    case 'urlMatches':
      return `url ${c.match ?? 'contains'} ${JSON.stringify(c.pattern)}`;
    case 'textPresent':
      return `page text contains ${JSON.stringify(c.value)}`;
    case 'textAbsent':
      return `page text does not contain ${JSON.stringify(c.value)}`;
    case 'visible':
      return `"${c.locator.description}" is visible`;
    case 'notVisible':
      return `"${c.locator.description}" is not visible`;
    case 'count':
      return `"${c.locator.description}" count in [${c.min ?? 0}, ${c.max ?? '∞'}]`;
    case 'httpStatusAtLeast':
      return `http status >= ${c.status}`;
    case 'all':
      return c.of.map(describe).join(' AND ');
    case 'any':
      return c.of.map(describe).join(' OR ');
    case 'not':
      return `NOT (${describe(c.of)})`;
  }
}
