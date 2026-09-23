import type { Action, Condition, ControlRole, Locator, LocatorStrategy } from '../artifact/schema.js';

/**
 * ============================================================================
 * The surface seam
 * ============================================================================
 *
 * Everything above this file — the artifact, the agent loop, the replay engine,
 * the policy layer, escalation — is written against this interface and knows
 * nothing about Playwright, the DOM, or even the web.
 *
 * A surface must be able to do exactly four things:
 *   1. describe its current state in a way both an LLM and a matcher can use
 *      (`observe`),
 *   2. turn a recorded Locator back into a single concrete control, reporting
 *      WHICH strategy worked (`resolve`),
 *   3. perform an action (`perform`),
 *   4. hand its live session to a human and take it back (`handoff`).
 *
 * The desktop story is that a UIA/AX driver implements the same four methods.
 * `role`, `name`, `nearText` and `tableCell` strategies all have direct
 * equivalents in UI Automation; `fieldName`, `css` and `xpath` do not and are
 * simply never emitted by a desktop recorder. That asymmetry is why locator
 * strategies are a ranked list with a declared tier rather than one string.
 */

/**
 * A control as perceived right now. `ref` is an ephemeral handle valid only for
 * the observation that produced it.
 *
 * `candidateStrategies` is the important field. The perception layer, not the
 * model, decides how a control should be addressed: it inspects the control's
 * accessible name, its recovered visual label, its form-control name and its
 * position, and emits a ranked strategy list. The model only ever says "act on
 * ref c7"; it never authors a selector. This removes the most common failure of
 * LLM-driven recording — a plausible-looking but brittle selector invented by a
 * model that cannot see next month's markup.
 */
export type ControlDescriptor = {
  ref: string;
  role: ControlRole;
  /** Accessible name, when the control actually has one. */
  name?: string;
  /**
   * The visual label recovered from adjacent static text. This is what makes
   * legacy table-layout forms addressable at all: the control has no accessible
   * name, but the operator, the vendor manual and the training material all
   * call it "Member Number".
   */
  visualLabel?: string;
  /** Form control name. Part of the server wire contract; stable, web-only. */
  fieldName?: string;
  value?: string;
  enabled: boolean;
  framePath: string[];
  /** 'value' cells are read-only text; only `extract` may target them. */
  kind: 'interactive' | 'value';
  candidateStrategies: LocatorStrategy[];
};

export type FrameObservation = {
  framePath: string[];
  url: string;
  title: string;
  /** Accessibility-tree snapshot, trimmed. Primary signal for the model. */
  ariaSnapshot: string;
  /** Visible text, normalised and truncated. Used for outcome/condition matching. */
  text: string;
};

export type Observation = {
  url: string;
  title: string;
  /** Status of the last main-frame document response, when the surface knows it. */
  httpStatus?: number;
  frames: FrameObservation[];
  controls: ControlDescriptor[];
  /** Path to a screenshot on disk, when one was captured for this observation. */
  screenshotPath?: string;
  capturedAt: string;
};

export type ResolvedTarget = {
  /** Index into `Locator.strategies` that resolved. 0 means the preferred one held. */
  strategyIndex: number;
  strategy: LocatorStrategy;
  /** Opaque handle the surface understands. */
  handle: unknown;
};

export type ResolveFailure = {
  reason: 'not_found' | 'ambiguous' | 'frame_missing';
  /** Per-strategy diagnosis, so a failure says *why each attempt* failed. */
  attempts: Array<{ strategyIndex: number; kind: string; matched: number; error?: string }>;
};

export type ResolveResult = { ok: true; target: ResolvedTarget } | { ok: false; failure: ResolveFailure };

/** An action whose target has already been resolved (replay) or is a live ref (discovery). */
export type PerformableAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: ResolvedTarget }
  | { type: 'fill'; target: ResolvedTarget; value: string }
  | { type: 'select'; target: ResolvedTarget; value: string }
  | { type: 'press'; key: string; target?: ResolvedTarget }
  | { type: 'readText'; target: ResolvedTarget };

export type PerformResult = { ok: true; text?: string } | { ok: false; error: string };

/** Who may issue actions against the session right now. */
export type ControlHolder = 'automation' | 'operator' | 'none';

export interface Surface {
  readonly kind: 'web' | 'desktop' | 'terminal';

  observe(opts?: { screenshot?: boolean; screenshotPath?: string }): Promise<Observation>;

  resolve(locator: Locator, timeoutMs: number): Promise<ResolveResult>;

  /** Resolve an ephemeral ref from the most recent observation. */
  resolveRef(ref: string): Promise<ResolveResult>;

  perform(action: PerformableAction, timeoutMs: number): Promise<PerformResult>;

  evaluate(condition: Condition, timeoutMs: number): Promise<{ held: boolean; detail: string }>;

  screenshot(path: string): Promise<string | undefined>;

  /** Serialised page state for post-mortem debugging. */
  snapshot(path: string): Promise<string | undefined>;

  /**
   * Marks the start of a new step. Lets the surface scope per-step
   * observations — notably "did the application return an error status while
   * this step was running", which is otherwise indistinguishable from an error
   * three steps ago.
   */
  beginScope(): void;

  /** Current URL, cheap. */
  currentUrl(): Promise<string>;

  close(): Promise<void>;
}

/**
 * Control transfer is a property of the *session*, not of the surface driver,
 * because a human and the automation drive the same underlying session. Keeping
 * it in its own interface makes the invariant checkable: the executor asks
 * `assertHolder('automation')` before every action, so an action issued while a
 * human holds the session is a programming error that fails loudly rather than
 * a race that fights the operator's mouse.
 */
export interface SessionControl {
  holder(): ControlHolder;
  /** Give control to a human. Returns a descriptor of how to reach the session. */
  cedeToOperator(reason: string): Promise<OperatorAccess>;
  /** Take it back. Rejects if the operator has not released. */
  reclaim(): Promise<void>;
  assertHolder(expected: ControlHolder): void;
  /** Actions the human performed while holding control. */
  operatorActions(): OperatorAction[];
}

export type OperatorAccess = {
  /** CDP/remote endpoint or window handle a human tool can attach to. */
  endpoint: string;
  /** Human-facing URL of the operator console for this session. */
  consoleUrl: string;
  sessionId: string;
};

export type OperatorAction = {
  at: string;
  kind: 'click' | 'type' | 'navigate' | 'key' | 'note';
  target?: string;
  /** Redacted before it is ever written. */
  value?: string;
};

/** Convenience: does an artifact Action need a target resolved? */
export function actionNeedsTarget(a: Action): boolean {
  return a.type === 'click' || a.type === 'fill' || a.type === 'select' || a.type === 'extract';
}
