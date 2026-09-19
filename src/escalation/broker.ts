import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EscalationDisposition, EscalationTicket, Resolution } from './types.js';
import type { SessionController } from './session-control.js';
import type { Redactor } from '../policy/redaction.js';

/**
 * Routes intervention requests to a human and blocks the run until one answers.
 *
 * The broker is an in-process queue because this is a single-run demo, but the
 * interface is the queue interface: `raise` enqueues a self-contained ticket and
 * returns a promise, `resolve` completes it. Swapping the Map for a durable
 * queue and the promise for a poll is a change to this file only — nothing in
 * the executor knows how a human was reached.
 *
 * Tickets are written to disk as they change state, so the escalation is part
 * of the run's evidence rather than something that only ever existed in memory.
 */
export class EscalationBroker {
  private tickets = new Map<string, EscalationTicket>();
  private waiters = new Map<string, { resolve: (r: Resolution) => void; reject: (e: Error) => void }>();
  private sessions = new Map<string, SessionController>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly evidenceDir: string,
    private readonly redactor: Redactor,
  ) {
    mkdirSync(join(evidenceDir, 'escalations'), { recursive: true });
  }

  registerSession(sessionId: string, controller: SessionController): void {
    this.sessions.set(sessionId, controller);
  }

  session(sessionId: string): SessionController | undefined {
    return this.sessions.get(sessionId);
  }

  sessionForTicket(ticketId: string): SessionController | undefined {
    const t = this.tickets.get(ticketId);
    if (!t) return undefined;
    return this.sessions.get(t.runId);
  }

  list(): EscalationTicket[] {
    return [...this.tickets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(ticketId: string): EscalationTicket | undefined {
    return this.tickets.get(ticketId);
  }

  openForRun(runId: string): EscalationTicket | undefined {
    return [...this.tickets.values()].find((t) => t.runId === runId && t.status !== 'resolved');
  }

  /**
   * Raise an intervention request and wait for a human.
   *
   * `timeoutMs` exists because an unanswered escalation must not hold a browser
   * and a caller open forever. On timeout the run fails with an explicit
   * `ESCALATION_TIMEOUT`, which is a far better production signal than a
   * request that never returns.
   */
  async raise(input: Omit<EscalationTicket, 'ticketId' | 'createdAt' | 'status' | 'operatorActions'>, timeoutMs: number): Promise<Resolution> {
    const ticket: EscalationTicket = {
      ...input,
      ticketId: 'esc-' + randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      status: 'open',
      operatorActions: [],
      detail: this.redactor.text(input.detail),
      askedOf: this.redactor.text(input.askedOf),
    };
    this.tickets.set(ticket.ticketId, ticket);
    this.persist(ticket);

    return new Promise<Resolution>((resolve, reject) => {
      this.waiters.set(ticket.ticketId, { resolve, reject });
      const timer = setTimeout(() => {
        this.waiters.delete(ticket.ticketId);
        ticket.status = 'resolved';
        ticket.disposition = 'abort';
        ticket.operatorNotes = 'no operator responded before the timeout';
        this.persist(ticket);
        reject(new Error(`ESCALATION_TIMEOUT: no operator responded to ${ticket.ticketId} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.timers.set(ticket.ticketId, timer);
    });
  }

  claim(ticketId: string, operator: string): EscalationTicket {
    const t = this.mustGet(ticketId);
    if (t.status === 'resolved') throw new Error(`ticket ${ticketId} is already resolved`);
    const session = this.sessions.get(t.runId);
    if (!session) throw new Error(`no live session for run ${t.runId}`);
    if (session.holder() !== 'operator') {
      // cedeToOperator was already called by the executor before raising; this
      // guard catches the case where a ticket is claimed out of band.
      throw new Error(`session for ${t.runId} is held by "${session.holder()}", not available to claim`);
    }
    t.status = 'claimed';
    t.claimedBy = operator;
    t.claimedAt = new Date().toISOString();
    this.persist(t);
    return t;
  }

  resolve(ticketId: string, disposition: EscalationDisposition, notes?: string): EscalationTicket {
    const t = this.mustGet(ticketId);
    const waiter = this.waiters.get(ticketId);
    if (!waiter) throw new Error(`ticket ${ticketId} has no waiting run`);
    const session = this.sessions.get(t.runId);
    const operatorActions = session?.operatorActions() ?? [];

    t.status = 'resolved';
    t.resolvedAt = new Date().toISOString();
    t.disposition = disposition;
    t.operatorNotes = notes ? this.redactor.text(notes) : undefined;
    t.operatorActions = this.redactor.json(operatorActions);
    this.persist(t);

    const timer = this.timers.get(ticketId);
    if (timer) clearTimeout(timer);
    this.timers.delete(ticketId);
    this.waiters.delete(ticketId);
    waiter.resolve({ disposition, notes, operatorActions });
    return t;
  }

  private mustGet(id: string): EscalationTicket {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`unknown ticket ${id}`);
    return t;
  }

  private persist(t: EscalationTicket): void {
    writeFileSync(
      join(this.evidenceDir, 'escalations', `${t.ticketId}.json`),
      JSON.stringify(this.redactor.json(t), null, 2) + '\n',
      'utf8',
    );
  }
}
