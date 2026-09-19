import type { ControlHolder, OperatorAccess, OperatorAction, SessionControl } from '../surface/types.js';
import type { WebSurface } from '../surface/web-playwright.js';

/**
 * ============================================================================
 * The control-transfer model
 * ============================================================================
 *
 * A single session, one holder at a time, transitions logged.
 *
 *      automation ──cede──► operator ──release──► automation
 *           │                                          │
 *           └──────────────── abort ───────────────────┘ (none)
 *
 * Two properties matter more than the mechanism:
 *
 *  1. THE SESSION IS THE SAME OBJECT. The human does not get a fresh browser
 *     pointed at the same URL — they get the live page, with its cookies, its
 *     server-side session, its half-filled form and its frameset scroll
 *     position. Anything else silently loses the state that made the
 *     escalation necessary in the first place. In this implementation that is
 *     literally the same Playwright `Page`; in a deployed system it is the same
 *     browser container, reached over CDP (the endpoint is handed to the
 *     operator in the ticket, so the seam is real and not hypothetical).
 *
 *  2. HOLDERSHIP IS CHECKED, NOT ASSUMED. Every automation action calls
 *     `assertHolder('automation')` first. If a code path ever tries to act
 *     while a human holds the session, it throws immediately instead of racing
 *     the operator's mouse — which, on a screen that moves money, is the
 *     failure mode worth engineering against.
 *
 * Operator actions are recorded as they are issued through the operator API, so
 * the audit trail covers the human portion of the run too. A human who attaches
 * over raw CDP instead is outside that recording — an acknowledged gap, noted
 * in REPORT.md under Cuts.
 */
export class SessionController implements SessionControl {
  private state: ControlHolder = 'automation';
  private actions: OperatorAction[] = [];
  private transfers: Array<{ at: string; from: ControlHolder; to: ControlHolder; reason?: string }> = [];

  constructor(
    private readonly surface: WebSurface,
    readonly sessionId: string,
    private readonly consoleBaseUrl: string,
    private readonly cdpEndpoint: string,
    private readonly onTransfer?: (from: ControlHolder, to: ControlHolder, reason?: string) => void,
  ) {}

  holder(): ControlHolder {
    return this.state;
  }

  assertHolder(expected: ControlHolder): void {
    if (this.state !== expected) {
      throw new Error(
        `control-transfer violation: expected the session to be held by "${expected}" but it is held by "${this.state}". ` +
          `Automation must not act while an operator holds the session.`,
      );
    }
  }

  async cedeToOperator(reason: string): Promise<OperatorAccess> {
    this.transition('operator', reason);
    // Pause automation-side waiting so nothing races the human. There is no
    // background polling loop to stop: the executor is strictly sequential and
    // is blocked awaiting the escalation promise while the operator works.
    return {
      endpoint: this.cdpEndpoint,
      consoleUrl: `${this.consoleBaseUrl}/session/${this.sessionId}`,
      sessionId: this.sessionId,
    };
  }

  async reclaim(): Promise<void> {
    if (this.state !== 'operator') {
      throw new Error(`cannot reclaim: session is held by "${this.state}"`);
    }
    this.transition('automation', 'operator released');
  }

  abandon(reason: string): void {
    this.transition('none', reason);
  }

  private transition(to: ControlHolder, reason?: string): void {
    const from = this.state;
    this.state = to;
    this.transfers.push({ at: new Date().toISOString(), from, to, reason });
    this.onTransfer?.(from, to, reason);
  }

  /** Called by the operator API for each action a human performs. */
  recordOperatorAction(a: OperatorAction): void {
    this.assertHolder('operator');
    this.actions.push(a);
  }

  operatorActions(): OperatorAction[] {
    return [...this.actions];
  }

  transferLog(): Array<{ at: string; from: ControlHolder; to: ControlHolder; reason?: string }> {
    return [...this.transfers];
  }

  live(): WebSurface {
    return this.surface;
  }
}
