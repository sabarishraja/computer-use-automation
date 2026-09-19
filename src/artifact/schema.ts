import { z } from 'zod';

/**
 * ============================================================================
 * Capability artifact schema
 * ============================================================================
 *
 * A Capability is the durable output of a discovery run: a typed, versioned,
 * reviewable description of a flow through an application, decoupled from the
 * model transcript that produced it.
 *
 * Four constraints shaped this schema:
 *
 *  1. It is a CONTRACT, not a macro. A calling agent needs to know what the
 *     capability needs (`inputs`), what it returns (`outputs`), what non-failure
 *     answers it can give (`outcomes`) and how risky it is (`risk`) WITHOUT
 *     reading the steps. Everything an agent needs to decide "should I call
 *     this" lives above the `steps` array.
 *
 *  2. It is SURFACE-AGNOSTIC above the locator layer. Steps talk about intent
 *     and semantics ("the control labelled Member Number"), never about
 *     Playwright. A desktop surface driver consumes the same step list.
 *
 *  3. Locators are RANKED, not single. Legacy apps give you a mixture of good
 *     and bad handles on the same page, and which one holds is a per-tenant,
 *     per-version question. Recording a ranked list lets replay degrade
 *     gracefully and lets us observe drift (see `LocatorStrategy.tier`).
 *
 *  4. Exceptional states are DECLARED DATA, not code. `outcomes` and `recovery`
 *     are part of the artifact so a reviewer can see, in one file, every
 *     non-happy-path the capability knows about.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

/* -------------------------------------------------------------------------- */
/* Locators                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Robustness tier of a locator strategy. Ordering is meaningful: replay tries
 * strategies in the order written, and the tier is what makes a ranked list
 * reviewable — a capability whose only strategy is `fragile` should not be
 * approved for unattended use.
 *
 *  semantic   - derived from the accessibility tree (role + accessible name).
 *               Portable across web and desktop, survives restyling and markup
 *               rewrites, usually survives vendor minor versions.
 *  structural - derived from stable application structure that is not
 *               presentation: a form control's `name`, or a field's relationship
 *               to its label text. Legacy-friendly and vendor-stable, but
 *               web-specific in the case of `fieldName`.
 *  positional - "the 4th cell of the row whose first cell says X". Survives
 *               restyling, breaks when columns are reordered.
 *  fragile    - CSS/XPath tied to presentation. Recorded as a last-resort
 *               fallback and flagged so review can see the dependency.
 */
export const LocatorTier = z.enum(['semantic', 'structural', 'positional', 'fragile']);
export type LocatorTier = z.infer<typeof LocatorTier>;

export const TextMatch = z.enum(['exact', 'contains', 'regex']);
export type TextMatch = z.infer<typeof TextMatch>;

/**
 * Roles are the ARIA role vocabulary, deliberately restricted to the subset that
 * has a faithful equivalent in Windows UI Automation / macOS AX, so the same
 * strategy survives the jump to a desktop surface.
 */
export const ControlRole = z.enum([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'heading',
  'cell',
  'row',
  'table',
  'listitem',
  'menuitem',
  'tab',
  'dialog',
  'region',
]);
export type ControlRole = z.infer<typeof ControlRole>;

const StrategyBase = { tier: LocatorTier };

export const LocatorStrategy = z.discriminatedUnion('kind', [
  /** Accessibility role + accessible name. The preferred strategy everywhere. */
  z.object({
    ...StrategyBase,
    kind: z.literal('role'),
    role: ControlRole,
    name: z.string().optional(),
    match: TextMatch.default('exact'),
  }),
  /** A control associated with a <label>, or a desktop control with a LabeledBy relation. */
  z.object({ ...StrategyBase, kind: z.literal('label'), text: z.string(), match: TextMatch.default('exact') }),
  /**
   * The legacy-app workhorse: "the input immediately after the static text
   * 'Member Number:'". Table-layout apps have no <label for>, but the visual
   * label is still the most stable thing on the page — it is what the vendor's
   * own documentation and the operator's training material both use.
   */
  z.object({
    ...StrategyBase,
    kind: z.literal('nearText'),
    anchor: z.string(),
    anchorMatch: TextMatch.default('exact'),
    direction: z.enum(['following', 'preceding']).default('following'),
    control: ControlRole.optional(),
    /** 1-based: the nth matching control after the anchor. */
    ordinal: z.number().int().min(1).default(1),
  }),
  /** Literal text node, for links and read-only values. */
  z.object({ ...StrategyBase, kind: z.literal('text'), value: z.string(), match: TextMatch.default('exact') }),
  /**
   * HTML form-control `name`. Not semantic, but in server-rendered enterprise
   * apps it is part of the wire contract with the backend and therefore changes
   * far less often than markup or CSS. Web-only.
   */
  z.object({ ...StrategyBase, kind: z.literal('fieldName'), name: z.string() }),
  /** Cell addressed by its row's key text plus a column header or index. */
  z.object({
    ...StrategyBase,
    kind: z.literal('tableCell'),
    rowContains: z.string(),
    column: z.union([z.string(), z.number().int().min(0)]),
  }),
  /** Last resort. Recorded so replay has something, flagged so review sees it. */
  z.object({ ...StrategyBase, kind: z.literal('css'), selector: z.string() }),
  z.object({ ...StrategyBase, kind: z.literal('xpath'), expression: z.string() }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

/**
 * A frame path addresses a document inside a frameset by frame `name`, which is
 * how framesets are authored and therefore stable. On a desktop surface the same
 * field addresses a window/pane path. Empty array = the top-level document.
 */
export const FramePath = z.array(z.string()).default([]);

export const Locator = z.object({
  /**
   * What a human would say. Carried through to logs, escalation requests and the
   * operator console, and used by the bounded LLM recovery path if it is enabled.
   * This is the part of a locator that never goes stale.
   */
  description: z.string(),
  framePath: FramePath,
  /** Tried in order. First strategy that resolves to exactly one control wins. */
  strategies: z.array(LocatorStrategy).min(1),
});
export type Locator = z.infer<typeof Locator>;

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Conditions are the single predicate language used for checkpoints, business
 * outcome detection, recovery triggers and step preconditions. One language for
 * all four means a reviewer learns it once, and means an outcome detector can be
 * promoted to a checkpoint (or vice versa) without rewriting it.
 */
export type Condition =
  | { kind: 'urlMatches'; pattern: string; match?: TextMatch }
  | { kind: 'textPresent'; value: string; match?: TextMatch; framePath?: string[] }
  | { kind: 'textAbsent'; value: string; match?: TextMatch; framePath?: string[] }
  | { kind: 'visible'; locator: Locator }
  | { kind: 'notVisible'; locator: Locator }
  | { kind: 'count'; locator: Locator; min?: number; max?: number }
  | { kind: 'httpStatusAtLeast'; status: number }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('urlMatches'), pattern: z.string(), match: TextMatch.optional() }),
    z.object({
      kind: z.literal('textPresent'),
      value: z.string(),
      match: TextMatch.optional(),
      framePath: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal('textAbsent'),
      value: z.string(),
      match: TextMatch.optional(),
      framePath: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal('visible'), locator: Locator }),
    z.object({ kind: z.literal('notVisible'), locator: Locator }),
    z.object({ kind: z.literal('count'), locator: Locator, min: z.number().optional(), max: z.number().optional() }),
    z.object({ kind: z.literal('httpStatusAtLeast'), status: z.number().int() }),
    z.object({ kind: z.literal('all'), of: z.array(Condition) }),
    z.object({ kind: z.literal('any'), of: z.array(Condition) }),
    z.object({ kind: z.literal('not'), of: Condition }),
  ]),
) as z.ZodType<Condition>;

/* -------------------------------------------------------------------------- */
/* Typed parameters                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Sensitivity is a first-class property of every input and output, not an
 * afterthought in the logger. It is what the redactor reads: the artifact
 * declares that `memberId` is an identifier and `balance` is financial data, and
 * every log line, evidence file and escalation payload is filtered accordingly.
 * A field can therefore never be accidentally logged in the clear by a code path
 * that forgot about it.
 *
 *  public       - safe to log verbatim (account type, branch code)
 *  identifier   - tenant-scoped identifier; logged as a stable hash
 *  financial    - balances and amounts; returned to the caller, never persisted
 *  pii          - names, addresses; returned to the caller, never persisted
 *  secret       - credentials, override codes, tokens; never returned, never
 *                 persisted, never sent to the model
 */
export const Sensitivity = z.enum(['public', 'identifier', 'financial', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamType = z.enum(['string', 'number', 'boolean', 'money', 'date']);
export type ParamType = z.infer<typeof ParamType>;

export const InputParam = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamType,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: Sensitivity.default('public'),
  /** Validated before the browser is even opened — a bad input is not a UI trip. */
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type InputParam = z.infer<typeof InputParam>;

export const OutputField = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamType,
  description: z.string(),
  sensitivity: Sensitivity.default('public'),
  /** False when the field is only populated on some outcomes. */
  required: z.boolean().default(true),
});
export type OutputField = z.infer<typeof OutputField>;

/* -------------------------------------------------------------------------- */
/* Actions and steps                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Risk class drives policy, not documentation. `read` steps run unattended;
 * `write_reversible` steps run unattended only if the capability is approved;
 * `write_irreversible` steps are blocked unless a human confirms them, every
 * time. The classification lives on the step because a single capability
 * legitimately mixes classes (search, then post).
 */
export const RiskClass = z.enum(['read', 'write_reversible', 'write_irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

/**
 * Values are templates over `{{inputs.x}}` and `{{outputs.y}}`. Templating
 * rather than literal values is what makes a recorded run a *parameterized*
 * capability instead of a replay of one specific transaction.
 */
export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('click'), target: Locator }),
  z.object({ type: z.literal('fill'), target: Locator, value: z.string() }),
  z.object({ type: z.literal('select'), target: Locator, value: z.string() }),
  z.object({ type: z.literal('press'), key: z.string(), target: Locator.optional() }),
  z.object({
    type: z.literal('extract'),
    target: Locator,
    /** Name of a declared output field. */
    field: z.string(),
    /** Applied to the control's text before it is coerced to the declared type. */
    transform: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('trim') }),
        z.object({ kind: z.literal('money') }),
        z.object({ kind: z.literal('number') }),
        z.object({ kind: z.literal('regex'), pattern: z.string(), group: z.number().int().default(1) }),
      ])
      .optional(),
  }),
  z.object({ type: z.literal('waitFor'), condition: Condition }),
  z.object({ type: z.literal('assert'), condition: Condition }),
]);
export type Action = z.infer<typeof Action>;

/**
 * A recovery rule is a declared, bounded answer to a known runtime interruption.
 * Bounded is the operative word: `maxAttempts` and a fixed action list mean
 * recovery can never become an open-ended agent loop wearing a different hat.
 *
 * Rules are evaluated *before* a step's action when `when` matches the current
 * state, and again after a step fails its checkpoint.
 */
export const RecoveryRule = z.object({
  id: z.string(),
  description: z.string(),
  when: Condition,
  do: z.array(Action),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /** Where the rule applies. `global` rules are checked on every step. */
  scope: z.enum(['global', 'step']).default('global'),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

export const Step = z.object({
  id: z.string(),
  /** Human-readable intent. Survives every kind of drift; used in errors and escalations. */
  intent: z.string(),
  action: Action,
  risk: RiskClass.default('read'),
  /** Must hold before the action runs. A failed precondition is a hard failure, not a retry. */
  precondition: Condition.optional(),
  /** Must hold after the action. This is what makes a step verified rather than assumed. */
  checkpoint: Condition.optional(),
  /** Step-scoped recovery rules, tried in order before the global ones. */
  recovery: z.array(RecoveryRule).default([]),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  /** When true, a failure here is reported but does not abort the run. */
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof Step>;

/* -------------------------------------------------------------------------- */
/* Business outcomes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A declared, legitimate, non-success answer.
 *
 * This is the single most important modelling decision in the artifact. "No such
 * member" is an answer the calling agent needs, not an exception: if it arrives
 * as a thrown error the agent cannot distinguish "the member does not exist"
 * from "our automation is broken", and the whole system becomes untrustworthy.
 *
 * Outcomes are checked after every step, so they short-circuit the flow the
 * moment the app reveals one, rather than being inferred from a downstream
 * checkpoint failure.
 */
export const BusinessOutcome = z.object({
  /** SCREAMING_SNAKE, stable, part of the capability's public contract. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  when: Condition,
  /** Message template shown to the caller; may reference {{inputs.x}}. */
  message: z.string(),
  /** Outputs that are still populated when this outcome fires. */
  partialOutputs: z.array(z.string()).default([]),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;

/* -------------------------------------------------------------------------- */
/* Surface binding                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The seam between "how we perceive and act on a surface" and "the recorded
 * flow". Everything above this object is surface-independent; a `desktop`
 * binding would swap the driver without touching steps, outcomes or contract.
 */
export const SurfaceBinding = z.object({
  kind: z.enum(['web', 'desktop', 'terminal']),
  /** Entry point template; `{{env.baseUrl}}` is substituted at replay time. */
  entry: z.string(),
  /** Vendor product identity — the key for cross-tenant reuse. */
  application: z.object({
    vendor: z.string(),
    product: z.string(),
    /** Semver range the capability was recorded against and is believed to hold for. */
    versionRange: z.string(),
  }),
  /** Viewport pinned so positional strategies and screenshots are comparable. */
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1280, height: 800 }),
});
export type SurfaceBinding = z.infer<typeof SurfaceBinding>;

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

export const CapabilityPolicy = z.object({
  /** URL-prefix allowlist. Replay refuses to navigate anywhere else. */
  allowedOrigins: z.array(z.string()).min(1),
  allowedPathPrefixes: z.array(z.string()).default([]),
  /** The highest risk class this capability may execute unattended. */
  maxUnattendedRisk: RiskClass.default('read'),
  /** Output names the caller receives but that are never written to evidence. */
  neverPersist: z.array(z.string()).default([]),
  /** Replay refuses to start if the capability is not in one of these states. */
  requiresApprovalState: z.array(z.enum(['draft', 'approved', 'deprecated'])).default(['approved']),
});
export type CapabilityPolicy = z.infer<typeof CapabilityPolicy>;

/* -------------------------------------------------------------------------- */
/* Cross-tenant overlays                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A tenant overlay is a *patch*, not a copy.
 *
 * Hundreds of institutions run the same vendor product with different branding,
 * terminology and minor versions. Copying the artifact per tenant means a fix
 * has to be applied hundreds of times and drift is invisible. Instead the base
 * artifact is recorded once against a reference instance, and each tenant
 * contributes the smallest possible diff: a different entry URL, an extra
 * locator strategy to try first, an extra recovery rule for an interstitial that
 * only they have.
 *
 * Overlays are additive by construction: they can PREPEND locator strategies and
 * ADD recovery rules and outcomes, but they cannot remove or reorder steps. A
 * tenant that needs a different step list needs a different capability, and
 * making that impossible to express by accident is deliberate.
 */
export const TenantOverlay = z.object({
  tenantId: z.string(),
  institution: z.string().optional(),
  /**
   * Tenant vocabulary: the same vendor product configured with different
   * words. Applied to accessible names, near-text anchors, column headers and
   * checkpoint text. Usually this map alone is the whole overlay — see
   * `src/artifact/terms.ts` for why it is additive rather than replacing.
   */
  terms: z.record(z.string(), z.string()).default({}),
  /** Overrides `surface.entry`. */
  entry: z.string().optional(),
  /** Overrides the recorded product version for drift reporting. */
  productVersion: z.string().optional(),
  allowedOrigins: z.array(z.string()).default([]),
  /** stepId -> strategies to try BEFORE the base strategies. */
  locatorOverrides: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        framePath: z.array(z.string()).optional(),
        prependStrategies: z.array(LocatorStrategy).default([]),
      }),
    )
    .default({}),
  /** Extra recovery rules merged into the global set. */
  extraRecovery: z.array(RecoveryRule).default([]),
  /** Extra business outcomes, e.g. a tenant-specific denial message. */
  extraOutcomes: z.array(BusinessOutcome).default([]),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How this artifact came to exist. Deliberately a digest and a pointer rather
 * than the transcript itself: the artifact is the reviewable object and must not
 * carry model prose, and the transcript may contain data the artifact is not
 * allowed to persist.
 */
export const Provenance = z.object({
  recordedAt: z.string(),
  recordedBy: z.enum(['llm-discovery', 'human', 'imported']),
  goal: z.string(),
  model: z.string().optional(),
  discoveryRunId: z.string().optional(),
  /** sha256 of the redacted transcript stored under evidence/. */
  transcriptDigest: z.string().optional(),
  /** Steps a human edited after recording, so review can focus there. */
  humanEditedSteps: z.array(z.string()).default([]),
});
export type Provenance = z.infer<typeof Provenance>;

/* -------------------------------------------------------------------------- */
/* The capability                                                              */
/* -------------------------------------------------------------------------- */

export const Capability = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Stable, namespaced, human-readable. This is the name an agent calls. */
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  /** Written for the calling agent: what it does, when to use it. */
  description: z.string(),
  /**
   * draft      - recorded, unreviewed. Replay allowed only with --allow-draft.
   * approved   - a human reviewed the steps and locators. Unattended replay OK.
   * deprecated - still replayable, excluded from the catalog.
   */
  state: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
  surface: SurfaceBinding,
  inputs: z.array(InputParam).default([]),
  outputs: z.array(OutputField).default([]),
  steps: z.array(Step).min(1),
  /** Non-failure answers this capability can return. */
  outcomes: z.array(BusinessOutcome).default([]),
  /** Recovery rules evaluated on every step. */
  globalRecovery: z.array(RecoveryRule).default([]),
  /** The condition that means "we actually got there". Checked before returning success. */
  successCondition: Condition,
  policy: CapabilityPolicy,
  provenance: Provenance,
  tenantOverlays: z.array(TenantOverlay).default([]),
});
export type Capability = z.infer<typeof Capability>;

/* -------------------------------------------------------------------------- */
/* Structural validation beyond the type system                                */
/* -------------------------------------------------------------------------- */

export type ValidationIssue = { level: 'error' | 'warning'; message: string; path?: string };

/**
 * Checks the invariants Zod cannot express. Run on save and again on load, so a
 * hand-edited artifact cannot silently become incoherent — the most likely way
 * a reviewed capability goes wrong in practice.
 */
export function validateCapability(cap: Capability): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stepIds = new Set<string>();
  const declaredOutputs = new Set(cap.outputs.map((o) => o.name));
  const boundOutputs = new Set<string>();
  const inputNames = new Set(cap.inputs.map((i) => i.name));

  for (const [i, step] of cap.steps.entries()) {
    if (stepIds.has(step.id)) issues.push({ level: 'error', message: `duplicate step id "${step.id}"`, path: `steps[${i}]` });
    stepIds.add(step.id);

    if (step.action.type === 'extract') {
      if (!declaredOutputs.has(step.action.field)) {
        issues.push({
          level: 'error',
          message: `step "${step.id}" extracts into undeclared output "${step.action.field}"`,
          path: `steps[${i}].action.field`,
        });
      }
      boundOutputs.add(step.action.field);
    }

    // Every step that changes state must be verified. An unverified write is the
    // failure mode where replay reports success having done nothing.
    if (step.risk !== 'read' && !step.checkpoint) {
      issues.push({
        level: 'error',
        message: `step "${step.id}" is ${step.risk} but has no checkpoint`,
        path: `steps[${i}].checkpoint`,
      });
    }

    for (const tmpl of templatesIn(step.action)) {
      for (const ref of referencedNames(tmpl)) {
        if (ref.scope === 'inputs' && !inputNames.has(ref.name)) {
          issues.push({ level: 'error', message: `step "${step.id}" references unknown input "${ref.name}"`, path: `steps[${i}]` });
        }
        if (ref.scope === 'outputs' && !declaredOutputs.has(ref.name)) {
          issues.push({ level: 'error', message: `step "${step.id}" references unknown output "${ref.name}"`, path: `steps[${i}]` });
        }
      }
    }

    for (const loc of locatorsIn(step.action)) {
      if (loc.strategies.every((s) => s.tier === 'fragile')) {
        issues.push({
          level: 'warning',
          message: `step "${step.id}" target "${loc.description}" has only fragile strategies; it will break on any markup change`,
          path: `steps[${i}]`,
        });
      }
    }
  }

  for (const o of cap.outputs) {
    if (o.required && !boundOutputs.has(o.name)) {
      issues.push({ level: 'error', message: `required output "${o.name}" is never extracted by any step` });
    }
    if (o.sensitivity === 'secret') {
      issues.push({ level: 'error', message: `output "${o.name}" is classified secret; secrets must never be returned to a caller` });
    }
  }

  for (const oc of cap.outcomes) {
    for (const name of oc.partialOutputs) {
      if (!declaredOutputs.has(name)) {
        issues.push({ level: 'error', message: `outcome ${oc.code} lists undeclared partial output "${name}"` });
      }
    }
  }

  if (cap.policy.allowedOrigins.length === 0) {
    issues.push({ level: 'error', message: 'policy.allowedOrigins must not be empty' });
  }

  const maxRisk = cap.steps.reduce<RiskClass>((acc, s) => (riskRank(s.risk) > riskRank(acc) ? s.risk : acc), 'read');
  if (riskRank(maxRisk) > riskRank(cap.policy.maxUnattendedRisk)) {
    issues.push({
      level: 'warning',
      message: `capability contains ${maxRisk} steps but maxUnattendedRisk is ${cap.policy.maxUnattendedRisk}; those steps will require confirmation at replay time`,
    });
  }

  return issues;
}

export function riskRank(r: RiskClass): number {
  return { read: 0, write_reversible: 1, write_irreversible: 2 }[r];
}

/** Highest risk class present in a capability's steps. Part of the catalog contract. */
export function capabilityRisk(cap: Capability): RiskClass {
  return cap.steps.reduce<RiskClass>((acc, s) => (riskRank(s.risk) > riskRank(acc) ? s.risk : acc), 'read');
}

function templatesIn(a: Action): string[] {
  switch (a.type) {
    case 'navigate':
      return [a.url];
    case 'fill':
    case 'select':
      return [a.value];
    default:
      return [];
  }
}

function locatorsIn(a: Action): Locator[] {
  if ('target' in a && a.target) return [a.target as Locator];
  return [];
}

const TEMPLATE_RE = /\{\{\s*(inputs|outputs|env)\.([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function referencedNames(template: string): Array<{ scope: 'inputs' | 'outputs' | 'env'; name: string }> {
  const out: Array<{ scope: 'inputs' | 'outputs' | 'env'; name: string }> = [];
  for (const m of template.matchAll(TEMPLATE_RE)) {
    out.push({ scope: m[1] as 'inputs' | 'outputs' | 'env', name: m[2] as string });
  }
  return out;
}

/** Substitutes {{inputs.x}} / {{outputs.y}} / {{env.z}} into a template string. */
export function renderTemplate(
  template: string,
  ctx: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown>; env?: Record<string, string> },
): string {
  return template.replace(TEMPLATE_RE, (_all, scope: string, name: string) => {
    const bag = (ctx as Record<string, Record<string, unknown> | undefined>)[scope];
    const v = bag?.[name];
    if (v === undefined || v === null) throw new Error(`template references ${scope}.${name}, which is not set`);
    return String(v);
  });
}
