/**
 * ============================================================================
 * Scripted operator
 * ============================================================================
 *
 * A stand-in for a human, used so the escalation path can be demonstrated in a
 * single non-interactive command and asserted in tests.
 *
 * The important property: it is an ORDINARY CLIENT OF THE OPERATOR API. It
 * polls the queue, claims a ticket, reads the live control inventory, acts
 * through `/api/ticket/:id/act`, and releases with a disposition — exactly the
 * calls the browser console makes. There is no privileged back door and no
 * in-process shortcut, so what it exercises is the real control-transfer
 * mechanism rather than a simulation of one.
 *
 * What is mocked is the judgement: a real supervisor reads the screen and
 * decides. This script matches on the screen's wording and applies a fixed
 * playbook. That is the documented seam.
 */
export type OperatorPlaybook = {
  /** Applied when the ticket's screen contains this text. */
  when: string;
  /** Control label (accessible name, visual label or field name) -> value to type. */
  type?: Record<string, string>;
  /** Control labels to click, in order, after typing. */
  click?: string[];
  disposition: 'resume' | 'resume_step_done' | 'abort';
  notes: string;
};

export type AutoOperatorOptions = {
  consoleBaseUrl: string;
  playbooks: OperatorPlaybook[];
  /** Give up waiting for a ticket after this long. */
  timeoutMs: number;
  /**
   * Stop waiting early. The run itself knows when no further escalation can
   * arrive; without this the poll loop holds the CLI open for the full
   * timeout on every run that never escalates.
   */
  signal?: AbortSignal;
  pollMs?: number;
  log?: (msg: string) => void;
};

export async function runAutoOperator(opts: AutoOperatorOptions): Promise<{ handled: number }> {
  const log = opts.log ?? (() => {});
  const deadline = Date.now() + opts.timeoutMs;
  const poll = opts.pollMs ?? 500;
  const seen = new Set<string>();
  let handled = 0;

  while (Date.now() < deadline && !opts.signal?.aborted) {
    const tickets = (await getJson(`${opts.consoleBaseUrl}/api/tickets`).catch(() => [])) as Array<{
      ticketId: string;
      status: string;
      detail: string;
      stepIntent?: string;
    }>;
    const open = tickets.find((t) => t.status === 'open' && !seen.has(t.ticketId));
    if (!open) {
      await sleep(poll);
      continue;
    }
    seen.add(open.ticketId);
    log(`[operator] picked up ${open.ticketId}: ${open.detail.split('\n')[0]}`);

    await postJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/claim`, { operator: 'scripted-supervisor' });

    const view = (await getJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/controls`)) as {
      url: string;
      controls: Array<{ ref: string; role: string; label: string }>;
    };

    // Screen matching uses the ticket's own detail plus the control labels, so
    // the playbook keys on what the operator would actually read.
    const haystack = `${open.detail} ${open.stepIntent ?? ''} ${view.controls.map((c) => c.label).join(' ')}`.toLowerCase();
    const play = opts.playbooks.find((p) => haystack.includes(p.when.toLowerCase()));

    if (!play) {
      log(`[operator] no playbook matches ${open.ticketId}; aborting the run`);
      await postJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/resolve`, {
        disposition: 'abort',
        notes: 'no playbook matched this screen',
      });
      handled++;
      continue;
    }

    for (const [label, value] of Object.entries(play.type ?? {})) {
      const c = view.controls.find((x) => x.label.toLowerCase().includes(label.toLowerCase()));
      if (!c) {
        log(`[operator] could not find a control labelled "${label}"`);
        continue;
      }
      await postJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/act`, { kind: 'type', ref: c.ref, value });
      log(`[operator] typed into "${c.label}"`);
    }

    for (const label of play.click ?? []) {
      const fresh = (await getJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/controls`)) as {
        controls: Array<{ ref: string; label: string }>;
      };
      const c = fresh.controls.find((x) => x.label.toLowerCase().includes(label.toLowerCase()));
      if (!c) {
        log(`[operator] could not find a control labelled "${label}"`);
        continue;
      }
      await postJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/act`, { kind: 'click', ref: c.ref });
      log(`[operator] clicked "${c.label}"`);
    }

    await postJson(`${opts.consoleBaseUrl}/api/ticket/${open.ticketId}/resolve`, {
      disposition: play.disposition,
      notes: play.notes,
    });
    log(`[operator] released ${open.ticketId} as ${play.disposition}`);
    handled++;
    // Keep watching. A single run can need a supervisor twice — an override for
    // the deposit, then an authorisation for the irreversible post — and
    // returning after the first left the second waiting out the full ticket
    // timeout. The run's own abort signal is what ends this loop.
  }

  return { handled };
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${url}: ${JSON.stringify(j)}`);
  return j;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
