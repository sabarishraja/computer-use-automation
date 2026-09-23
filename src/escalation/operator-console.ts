import express from 'express';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { EscalationBroker } from './broker.js';
import { Redactor } from '../policy/redaction.js';
import type { EscalationDisposition } from './types.js';

/**
 * ============================================================================
 * Operator console
 * ============================================================================
 *
 * Deliberately minimal, deliberately real.
 *
 * The brief puts a full co-browsing console out of scope, so this is not one:
 * there is no video stream, no input forwarding at the pixel level, no
 * multi-operator presence. What it does provide is an honest control surface
 * over the SAME live session the automation was using:
 *
 *   - the live screen, refreshed on a poll,
 *   - the live control inventory, so the operator clicks "the Override Code
 *     field" rather than a pixel coordinate (this is the same perception layer
 *     the agent uses, which is why it was worth building once),
 *   - every operator action recorded into the run's evidence,
 *   - an explicit release that hands control back and resumes the run.
 *
 * Acting by control rather than by coordinate is not just convenient: it means
 * the human's actions are recorded in the same vocabulary as the automation's,
 * so "what did the operator actually do" is answerable, and a frequently
 * repeated manual fix is a candidate for promotion into the artifact's recovery
 * rules rather than folklore.
 *
 * What a production version adds is listed in REPORT.md under Cuts.
 */
export class OperatorConsole {
  private server?: Server;
  readonly baseUrl: string;

  constructor(
    private readonly broker: EscalationBroker,
    private readonly port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get('/', (_req, res) => {
      const rows = this.broker
        .list()
        .map(
          (t) =>
            `<tr><td><a href="/ticket/${encodeURIComponent(t.ticketId)}">${esc(t.ticketId)}</a></td><td>${esc(t.reason)}</td>` +
            `<td>${esc(t.capabilityId ?? t.goal ?? '')}</td><td>${esc(t.stepIntent ?? '')}</td><td>${esc(t.status)}</td></tr>`,
        )
        .join('');
      res.type('html').send(
        page(
          'Intervention queue',
          `<table class="grid"><tr><th>Ticket</th><th>Reason</th><th>Capability</th><th>Step</th><th>Status</th></tr>${rows || '<tr><td colspan="5">No tickets.</td></tr>'}</table>
           <p class="muted">This page does not auto-refresh; reload to see new tickets.</p>`,
        ),
      );
    });

    app.get('/ticket/:id', (req, res) => {
      const t = this.broker.get(String(req.params.id));
      if (!t) return res.status(404).type('html').send(page('Not found', '<p>No such ticket.</p>'));
      return res.type('html').send(ticketPage(t.ticketId));
    });

    /* ------------------------------- API ------------------------------- */

    app.get('/api/tickets', (_req, res) => res.json(this.broker.list()));

    app.get('/api/ticket/:id', (req, res) => {
      const t = this.broker.get(String(req.params.id));
      if (!t) return res.status(404).json({ error: 'unknown ticket' });
      return res.json(t);
    });

    app.post('/api/ticket/:id/claim', (req, res) => {
      try {
        const operator = String((req.body as Record<string, unknown>)?.operator ?? 'operator');
        return res.json(this.broker.claim(String(req.params.id), operator));
      } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
      }
    });

    /** Live pixels from the same session the automation was driving. */
    app.get('/api/ticket/:id/screen.png', async (req, res) => {
      const session = this.broker.sessionForTicket(String(req.params.id));
      if (!session) return res.status(404).end();
      try {
        const buf = await session.live().livePage().screenshot({ timeout: 8000 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(buf);
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
    });

    /** The same control inventory the agent sees, so the human can act semantically. */
    app.get('/api/ticket/:id/controls', async (req, res) => {
      const session = this.broker.sessionForTicket(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'no session' });
      const obs = await session.live().observe();
      return res.json({
        url: obs.url,
        controls: obs.controls.map((c) => ({
          ref: c.ref,
          role: c.role,
          label: c.name ?? c.visualLabel ?? c.fieldName ?? '(unnamed)',
          frame: c.framePath.join('/') || '<top>',
          enabled: c.enabled,
        })),
      });
    });

    /**
     * Perform one operator action on the live session.
     *
     * The holder check inside SessionController is what makes this safe: the
     * automation cannot be acting concurrently, because it is blocked on the
     * escalation promise and would throw if it tried.
     */
    app.post('/api/ticket/:id/act', async (req, res) => {
      const session = this.broker.sessionForTicket(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'no session' });
      const body = (req.body ?? {}) as { kind?: string; ref?: string; value?: string; url?: string; key?: string; note?: string };
      const surface = session.live();
      try {
        session.assertHolder('operator');
        switch (body.kind) {
          case 'click':
          case 'type': {
            const r = await surface.resolveRef(String(body.ref));
            if (!r.ok) return res.status(400).json({ error: `could not resolve ${body.ref}: ${r.failure.reason}` });
            const perf =
              body.kind === 'click'
                ? await surface.perform({ type: 'click', target: r.target }, 10_000)
                : await surface.perform({ type: 'fill', target: r.target, value: String(body.value ?? '') }, 10_000);
            if (!perf.ok) return res.status(400).json({ error: perf.error });
            session.recordOperatorAction({
              at: new Date().toISOString(),
              kind: body.kind === 'click' ? 'click' : 'type',
              target: String(body.ref),
              // The value is redacted before it is persisted by the broker; a
              // supervisor override code must never survive the run.
              value: body.kind === 'type' ? '[operator-entered]' : undefined,
            });
            return res.json({ ok: true });
          }
          case 'navigate': {
            const perf = await surface.perform({ type: 'navigate', url: String(body.url) }, 15_000);
            if (!perf.ok) return res.status(400).json({ error: perf.error });
            session.recordOperatorAction({ at: new Date().toISOString(), kind: 'navigate', target: String(body.url) });
            return res.json({ ok: true });
          }
          case 'key': {
            const perf = await surface.perform({ type: 'press', key: String(body.key) }, 10_000);
            if (!perf.ok) return res.status(400).json({ error: perf.error });
            session.recordOperatorAction({ at: new Date().toISOString(), kind: 'key', target: String(body.key) });
            return res.json({ ok: true });
          }
          case 'note': {
            session.recordOperatorAction({ at: new Date().toISOString(), kind: 'note', value: String(body.note ?? '') });
            return res.json({ ok: true });
          }
          default:
            return res.status(400).json({ error: `unknown action kind "${body.kind}"` });
        }
      } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
      }
    });

    /** Hand control back and tell the run what to do next. */
    app.post('/api/ticket/:id/resolve', (req, res) => {
      const body = (req.body ?? {}) as { disposition?: EscalationDisposition; notes?: string };
      const disposition = body.disposition ?? 'resume';
      try {
        const t = this.broker.resolve(String(req.params.id), disposition, body.notes);
        return res.json(t);
      } catch (e) {
        return res.status(409).json({ error: (e as Error).message });
      }
    });

    await new Promise<void>((resolve) => {
      // Loopback only: this console can take over a live session and has no
      // authentication, so it must not be reachable from the network.
      this.server = app.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

/* ------------------------------ views ---------------------------------- */

/**
 * Everything interpolated into this console is untrusted: ticket `detail`
 * embeds application page text, and `stepIntent` comes from an artifact a
 * human may have edited. This page can drive a live banking session while the
 * operator holds control, so script running here is not cosmetic.
 */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title} · Operator Console</title><style>
  body{font-family:ui-sans-serif,system-ui,Segoe UI,sans-serif;font-size:13px;margin:0;background:#0f1115;color:#e6e6e6}
  header{background:#181c24;padding:10px 16px;border-bottom:1px solid #2a2f3a;font-weight:600}
  main{padding:16px;max-width:1100px}
  a{color:#7fb2ff}
  .grid{border-collapse:collapse;width:100%}
  .grid td,.grid th{border:1px solid #2a2f3a;padding:6px 8px;text-align:left}
  .grid th{background:#181c24}
  .muted{color:#8a93a3}
  .card{border:1px solid #2a2f3a;background:#151922;padding:12px;margin-bottom:12px;border-radius:6px}
  button{font:inherit;background:#2b6cff;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer}
  button.secondary{background:#333a48}
  button.danger{background:#a33}
  input,select{font:inherit;background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;padding:5px;border-radius:4px}
  img{max-width:100%;border:1px solid #2a2f3a;background:#fff}
  code{color:#9fe8b0}
  </style></head><body><header>Operator Console</header><main>${body}</main></body></html>`;
}

/**
 * The console page is a small client so that the live screen and the live
 * control list stay current while the operator works. It talks to the same API
 * an automated or third-party operator tool would use — there is no privileged
 * path that only the built-in UI can take.
 */
function ticketPage(ticketId: string): string {
  return page(
    ticketId,
    `<div class="card" id="ctx">loading…</div>
     <div class="card">
       <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
         <div style="flex:2;min-width:420px">
           <img id="shot" alt="live session">
           <div class="muted">Live view of the automation's own session, refreshed every 1.5s.</div>
         </div>
         <div style="flex:1;min-width:280px">
           <h4 style="margin:0 0 8px">Controls</h4>
           <div id="controls" class="muted">claim the ticket to interact</div>
         </div>
       </div>
     </div>
     <div class="card">
       <button id="claim">Take control</button>
       <button id="resume" class="secondary">Release &amp; resume run</button>
       <button id="done" class="secondary">Release &amp; mark step done</button>
       <button id="abort" class="danger">Abort run</button>
       <input id="notes" placeholder="notes for the audit trail" style="width:320px">
       <div id="msg" class="muted" style="margin-top:8px"></div>
     </div>
<script>
const T = ${JSON.stringify(ticketId)};
const msg = (s) => document.getElementById('msg').textContent = s;
async function j(url, opts) { const r = await fetch(url, opts); const b = await r.json().catch(()=>({})); if(!r.ok) throw new Error(b.error||r.statusText); return b; }

async function refreshCtx(){
  const t = await j('/api/ticket/'+T);
  document.getElementById('ctx').innerHTML =
    '<b>'+escapeHtml(t.reason)+'</b> &middot; status <code>'+escapeHtml(t.status)+'</code><br>'+
    'Capability: <code>'+escapeHtml(t.capabilityId||'-')+'@'+escapeHtml(t.capabilityVersion||'-')+'</code> tenant <code>'+escapeHtml(t.tenantId||'-')+'</code><br>'+
    'Step '+escapeHtml(t.stepIndex??'-')+'/'+escapeHtml(t.stepCount??'-')+': <b>'+escapeHtml(t.stepIntent||'-')+'</b><br>'+
    '<div style="margin-top:6px">'+escapeHtml(t.detail)+'</div>'+
    '<div style="margin-top:6px"><b>Asked of you:</b> '+escapeHtml(t.askedOf)+'</div>'+
    '<div class="muted" style="margin-top:6px">Attach directly: <code>'+escapeHtml(t.sessionEndpoint||'n/a')+'</code></div>';
  return t;
}
function refreshShot(){ document.getElementById('shot').src = '/api/ticket/'+T+'/screen.png?ts='+Date.now(); }
async function refreshControls(){
  try {
    const d = await j('/api/ticket/'+T+'/controls');
    document.getElementById('controls').innerHTML = d.controls.map(c =>
      '<div style="margin-bottom:6px;border-bottom:1px solid #222a36;padding-bottom:6px">'+
      '<div><code>'+c.role+'</code> '+escapeHtml(c.label)+' <span class="muted">['+c.frame+']</span></div>'+
      '<button data-act="click" data-ref="'+c.ref+'">click</button> '+
      '<input data-in="'+c.ref+'" placeholder="value" style="width:110px"> '+
      '<button data-act="type" data-ref="'+c.ref+'" class="secondary">type</button>'+
      '</div>').join('') || '<span class="muted">no controls</span>';
  } catch(e) { document.getElementById('controls').textContent = e.message; }
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

document.getElementById('controls').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if(!b) return;
  const ref = b.dataset.ref, kind = b.dataset.act;
  const val = kind === 'type' ? document.querySelector('[data-in="'+ref+'"]').value : undefined;
  try { await j('/api/ticket/'+T+'/act', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind, ref, value: val})});
        msg(kind+' ok'); refreshShot(); setTimeout(refreshControls, 400); }
  catch(err){ msg(err.message); }
});
document.getElementById('claim').onclick = async () => {
  try { await j('/api/ticket/'+T+'/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operator:'console-user'})});
        msg('control taken'); refreshCtx(); refreshControls(); } catch(e){ msg(e.message); }
};
for (const [id, disposition] of [['resume','resume'],['done','resume_step_done'],['abort','abort']]) {
  document.getElementById(id).onclick = async () => {
    try { await j('/api/ticket/'+T+'/resolve',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({disposition, notes: document.getElementById('notes').value})});
          msg('released: '+disposition); refreshCtx(); } catch(e){ msg(e.message); }
  };
}
refreshCtx(); refreshShot(); refreshControls();
setInterval(refreshShot, 1500);
setInterval(refreshCtx, 3000);
</script>`,
  );
}

/**
 * `npm run operator` used to load this module and exit silently, so the
 * documented standalone console was a no-op that still reported success.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.OPERATOR_CONSOLE_PORT ?? 4180);
  const broker = new EscalationBroker(resolve(process.cwd(), 'evidence'), new Redactor('operator'));
  const consoleSrv = new OperatorConsole(broker, port);
  await consoleSrv.start();
  console.log(`[operator] console listening on ${consoleSrv.baseUrl}`);
  console.log('[operator] tickets raised by a replay run in this evidence directory will appear here.');
}
