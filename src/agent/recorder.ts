import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  validateCapability,
  type Action,
  type BusinessOutcome,
  type Capability,
  type Condition,
  type Locator,
  type RiskClass,
  type Step,
} from '../artifact/schema.js';
import type { ControlDescriptor } from '../surface/types.js';
import type { CapabilitySpec } from './spec.js';

/**
 * Turns a successful discovery run into a Capability.
 *
 * The recorder — not the model — owns three decisions that determine whether
 * the artifact is any good:
 *
 *  1. HOW CONTROLS ARE ADDRESSED. The model picks a control by ephemeral ref;
 *     the recorder writes the ranked strategy list the perception layer
 *     computed for it. The model never authors a selector, so it cannot author
 *     a brittle one.
 *
 *  2. WHAT BECOMES A PARAMETER. Any typed value that matches a declared input
 *     is rewritten as `{{inputs.x}}`; any value matching a credential is
 *     rewritten as `{{env.secret_x}}` and never stored. Parameterisation by
 *     value-matching against the authored contract is reliable in a way that
 *     asking a model "was that a parameter?" is not.
 *
 *  3. RISK CLASSIFICATION. Derived from the action and the control's label,
 *     not from the model's opinion, so a run cannot talk its way into
 *     unattended irreversible writes.
 */
export class Recorder {
  private steps: Step[] = [];
  private outcomeConditions = new Map<string, Condition>();
  private successCondition: Condition | null = null;

  constructor(
    private readonly spec: CapabilitySpec,
    private readonly baseUrl: string,
    /** name -> concrete value used during discovery. */
    private readonly inputValues: Record<string, string>,
    /** envKey -> concrete secret value. Used only to recognise and replace. */
    private readonly credentialValues: Record<string, string>,
  ) {}

  stepCount(): number {
    return this.steps.length;
  }

  lastStepId(): string | undefined {
    return this.steps.at(-1)?.id;
  }

  /**
   * A recorded write step that has not yet been proven. The artifact schema
   * refuses such a step, so the loop has to collect the checkpoint while the
   * screen is still on it — discovering the gap at save time would throw away
   * the whole run.
   */
  unprovenWriteStep(): { id: string; risk: RiskClass; intent: string } | undefined {
    // Every step, not just the last one. Inspecting only `steps.at(-1)` meant a
    // single step recorded after an unproven write hid it until save time —
    // the exact discard this gate exists to prevent.
    const step = this.steps.find((x) => x.risk !== 'read' && !x.checkpoint);
    return step ? { id: step.id, risk: step.risk, intent: step.intent } : undefined;
  }

  recordNavigate(url: string): Step {
    return this.push({
      intent: `Open ${this.templateUrl(url)}`,
      action: { type: 'navigate', url: this.templateUrl(url) },
      risk: 'read',
      timeoutMs: 20_000,
    });
  }

  recordClick(control: ControlDescriptor, why: string): Step {
    const target = this.locatorFor(control);
    return this.push({
      intent: why || `Click ${target.description}`,
      action: { type: 'click', target },
      risk: classifyClick(target.description),
      timeoutMs: 15_000,
    });
  }

  recordFill(control: ControlDescriptor, rawValue: string, why: string): Step {
    const target = this.locatorFor(control);
    return this.push({
      intent: why || `Enter a value into ${target.description}`,
      action: { type: 'fill', target, value: this.templateValue(rawValue) },
      // Typing into a field changes nothing durable until it is submitted.
      risk: 'read',
      timeoutMs: 10_000,
    });
  }

  recordSelect(control: ControlDescriptor, rawValue: string, why: string): Step {
    const target = this.locatorFor(control);
    return this.push({
      intent: why || `Choose a value in ${target.description}`,
      action: { type: 'select', target, value: this.templateValue(rawValue) },
      risk: 'read',
      timeoutMs: 10_000,
    });
  }

  recordExtract(control: ControlDescriptor, field: string, why: string): Step {
    const target = this.locatorFor(control);
    const declared = this.spec.outputs.find((o) => o.name === field);
    const transform =
      declared?.type === 'money' ? ({ kind: 'money' } as const) : declared?.type === 'number' ? ({ kind: 'number' } as const) : ({ kind: 'trim' } as const);
    return this.push({
      intent: why || `Read ${field}`,
      action: { type: 'extract', target, field, transform },
      risk: 'read',
      timeoutMs: 10_000,
    });
  }

  /** Attach a checkpoint to the most recent step. */
  attachCheckpoint(provingText: string, framePath: string[] | undefined): void {
    const step = this.steps.at(-1);
    if (!step) throw new Error('no step to attach a checkpoint to');
    step.checkpoint = { kind: 'textPresent', value: provingText, match: 'contains', framePath };
  }

  setSuccess(provingText: string, framePath: string[] | undefined): void {
    this.successCondition = { kind: 'textPresent', value: provingText, match: 'contains', framePath };
  }

  recordOutcome(code: string, provingText: string, framePath: string[] | undefined): void {
    this.outcomeConditions.set(code, { kind: 'textPresent', value: provingText, match: 'contains', framePath });
  }

  knownOutcomes(): string[] {
    return [...this.outcomeConditions.keys()];
  }

  /**
   * A checkpoint that mentions a value from this particular run is not a
   * checkpoint, it is a coincidence. Rejecting them here — rather than hoping
   * the prompt is persuasive — is what keeps a recorded capability from
   * asserting "the page says 123456" forever after.
   */
  validateProvingText(text: string, activeValues: Record<string, string> = {}): string | null {
    const t = text.trim();
    if (t.length < 4) return 'proving text must be at least 4 characters';
    if (t.length > 120) return 'proving text must be under 120 characters';
    // `activeValues` carries what the CURRENT phase is driving with. The
    // outcome-probe phases run with probe inputs the recorder was never
    // constructed with, so without this a detector could be recorded as
    // "No member record found for 000000." and then never fire for anyone else.
    for (const [name, value] of Object.entries({ ...this.inputValues, ...activeValues })) {
      if (String(value).length >= 3 && t.includes(String(value))) {
        return `proving text must not contain the value of input "${name}" — it would only hold for this one run. Use the surrounding static wording instead.`;
      }
    }
    for (const value of Object.values(this.credentialValues)) {
      if (value && t.includes(value)) return 'proving text must never contain a credential';
    }
    return null;
  }

  build(opts: { model: string; runId: string; transcriptDigest: string }): Capability {
    if (!this.successCondition) throw new Error('cannot build a capability without a success condition');

    const outcomes: BusinessOutcome[] = [];
    for (const o of this.spec.outcomes) {
      const when = this.outcomeConditions.get(o.code);
      if (!when) continue; // never observed; not recorded, rather than guessed
      outcomes.push({
        code: o.code,
        description: o.description,
        message: o.message,
        partialOutputs: o.partialOutputs ?? [],
        when,
      });
    }

    const cap: Capability = {
      schemaVersion: SCHEMA_VERSION,
      id: this.spec.id,
      version: this.spec.version,
      name: this.spec.name,
      description: this.spec.description,
      // Freshly recorded capabilities are drafts. Promotion to `approved` is a
      // human act, and unattended replay requires it.
      state: 'draft',
      surface: {
        kind: this.spec.app.surfaceKind,
        entry: this.spec.entry,
        application: this.spec.app.application,
        viewport: this.spec.app.viewport,
      },
      inputs: this.spec.inputs,
      outputs: this.spec.outputs,
      steps: this.steps,
      outcomes,
      globalRecovery: this.spec.app.globalRecovery,
      successCondition: this.successCondition,
      policy: this.spec.app.policy,
      provenance: {
        recordedAt: new Date().toISOString(),
        recordedBy: 'llm-discovery',
        goal: this.spec.goal,
        model: opts.model,
        discoveryRunId: opts.runId,
        transcriptDigest: opts.transcriptDigest,
        humanEditedSteps: [],
      },
      tenantOverlays: [],
    };

    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    if (errors.length > 0) {
      // The rejected recording travels with the error. A discovery run costs a
      // model call and several minutes; throwing the artifact away leaves a
      // reviewer with nothing to read but prose about what went wrong.
      throw new InvalidRecordingError(errors.map((e) => e.message), cap);
    }
    return cap;
  }

  /* --------------------------- internals --------------------------- */

  private push(partial: { intent: string; action: Action; risk: RiskClass; timeoutMs: number }): Step {
    const step: Step = {
      id: `s${String(this.steps.length + 1).padStart(2, '0')}-${kind(partial.action)}`,
      intent: partial.intent,
      action: partial.action,
      risk: partial.risk,
      recovery: [],
      timeoutMs: partial.timeoutMs,
      optional: false,
    };
    this.steps.push(step);
    return step;
  }

  private locatorFor(c: ControlDescriptor): Locator {
    return {
      description: c.name ?? c.visualLabel ?? c.fieldName ?? `${c.role} control`,
      framePath: c.framePath,
      strategies: c.candidateStrategies,
    };
  }

  private templateUrl(url: string): string {
    return url.startsWith(this.baseUrl) ? '{{env.baseUrl}}' + url.slice(this.baseUrl.length) : url;
  }

  private templateValue(raw: string): string {
    for (const [envKey, value] of Object.entries(this.credentialValues)) {
      if (value && raw === value) return `{{env.secret_${envKey}}}`;
    }
    for (const [name, value] of Object.entries(this.inputValues)) {
      if (String(value).length >= 2 && raw === String(value)) return `{{inputs.${name}}}`;
    }
    return raw;
  }
}

/**
 * Raised when a completed recording fails artifact validation. Carries the
 * rejected draft so discovery can write it out for a human to inspect.
 */
export class InvalidRecordingError extends Error {
  constructor(
    readonly issues: string[],
    readonly rejected: unknown,
  ) {
    super('the recorded capability is not valid:\n' + issues.map((m) => '  - ' + m).join('\n'));
    this.name = 'InvalidRecordingError';
  }
}

/**
 * Risk from the control's own label. A recording that clicks a button reading
 * "Confirm and Post" produces an irreversible step whatever else is going on,
 * which means the policy engine gates it at replay time without anyone having
 * remembered to classify it.
 */
function classifyClick(label: string): RiskClass {
  const l = label.toLowerCase();
  if (/permanently|delete|purge|close relationship|wire|charge off/.test(l)) return 'write_irreversible';
  if (/confirm and post|post |authorize|submit payment|transfer/.test(l)) return 'write_irreversible';
  // Submitting a form that creates or changes a record. A query button
  // ("Search", "Find") submits a form too but changes nothing, so it stays a
  // read — otherwise every lookup capability would need write permission.
  if (/submit|save|apply|create|open sub/.test(l)) return 'write_reversible';
  return 'read';
}

function kind(a: Action): string {
  return a.type;
}

export function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
