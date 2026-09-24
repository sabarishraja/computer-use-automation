import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { TENANTS, tenantOr404, type TenantConfig } from './tenants.js';
import { MEMBERS, DEMO_OPERATOR, resetMembers } from './data.js';
import { chrome, money } from './html.js';

/* ------------------------------------------------------------------ *
 * Chaos control
 *
 * Runtime exceptional states are the interesting part of this problem, so the
 * target app can be told to produce them on demand. This is how the replay
 * evidence for "record not found", "session expired", "unexpected dialog" and
 * "transient slowness" is produced deterministically instead of by luck.
 * ------------------------------------------------------------------ */
export type ChaosMode =
  | 'none'
  | 'slow' // transient 4.5s stall on search  -> recoverable
  | 'interstitial' // unexpected maintenance notice    -> recoverable
  | 'expire' // session invalidated              -> recoverable (re-auth)
  | 'apperror'; // HTTP 500 system error            -> hard failure

type Session = {
  id: string;
  tenant: string;
  operator: string | null;
  seenDisclosure: boolean;
  overrideGranted: boolean;
};

const SESSIONS = new Map<string, Session>();

/**
 * Armed runtime fault, global to the instance rather than per session.
 *
 * A replay starts a fresh browser with a fresh cookie, so a per-session switch
 * could never be armed from outside the run. Instance-global is the honest
 * shape for a single-user training instance and keeps the failure demos
 * reproducible from the command line.
 */
let ARMED: ChaosMode = 'none';
const OVERRIDE_CODE = '4417'; // known to a human supervisor, never to the agent
const OVERRIDE_THRESHOLD = 1000; // opening deposit at/above this needs an override

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req: Request, res: Response, tenant: string): Session {
  const sid = parseCookies(req)['mlsid'];
  const existing = sid ? SESSIONS.get(sid) : undefined;
  if (existing && existing.tenant === tenant) return existing;
  const s: Session = {
    id: randomUUID(),
    tenant,
    operator: null,
    seenDisclosure: false,
    overrideGranted: false,
  };
  SESSIONS.set(s.id, s);
  res.setHeader('Set-Cookie', 'mlsid=' + s.id + '; Path=/; HttpOnly; SameSite=Lax');
  return s;
}

/** Consume the armed fault. Fires at most once per arming, so a retry can succeed. */
function fire(mode: ChaosMode): boolean {
  if (ARMED === mode) {
    ARMED = 'none';
    return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ------------------------------------------------------------------ */

const app = express();
app.use(express.urlencoded({ extended: false }));

const base = (t: TenantConfig) => '/t/' + t.id;

app.get('/', (_req, res) => {
  const rows = Object.values(TENANTS)
    .map(
      (t) =>
        '<tr><td><a href="/t/' + t.id + '/">' + t.institution + '</a></td><td>' + t.productVersion + '</td><td>' + t.id + '</td></tr>',
    )
    .join('');
  res.type('html').send(
    '<!DOCTYPE html><html><head><title>MemberLink Instances</title></head>' +
      '<body style="font-family:Verdana;font-size:12px">' +
      '<h3>MemberLink Core Servicing &#183; training instances</h3>' +
      '<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:11px">' +
      '<tr><th>Institution</th><th>Version</th><th>Tenant key</th></tr>' +
      rows +
      '</table><p style="color:#666;font-size:11px">Two tenants, one vendor product. Synthetic data only.</p>' +
      '</body></html>',
  );
});

/** Arm a runtime fault for the calling session. Used by the replay demos. */
app.all('/t/:tenant/__reset', (_req, res) => {
  // The commit route mutates member accounts so a double-post is visible.
  // Tests and repeated demo runs need the fixture back.
  resetMembers();
  res.type('text').send('reset');
});

app.all('/t/:tenant/__chaos', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  ARMED = String(req.query.mode ?? 'none') as ChaosMode;
  return res.type('html').send(chrome(t, 'Diagnostics', '<div class="ok">Runtime fault armed: <b>' + ARMED + '</b></div>'));
});

/* ---------------------------- sign-on ----------------------------- */

app.get('/t/:tenant/signon', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  getSession(req, res, t.id);
  const msg = req.query.expired ? '<div class="err">Your session has expired. Sign on again to continue.</div>' : '';
  const bad = req.query.bad ? '<div class="err">Sign-on failed. Check operator ID and password.</div>' : '';
  return res.type('html').send(
    chrome(
      t,
      'Operator Sign-On',
      msg +
        bad +
        '<form method="post" action="' +
        base(t) +
        '/signon">' +
        '<input type="hidden" name="next" value="' +
        escapeAttr(String(req.query.next ?? '')) +
        '">' +
        '<table class="form">' +
        '<tr><td>Operator ID:</td><td><input type="text" name="opid" size="12"></td></tr>' +
        '<tr><td>Password:</td><td><input type="password" name="pw" size="12"></td></tr>' +
        '<tr><td></td><td><input type="submit" value="Sign On"></td></tr>' +
        '</table></form>',
    ),
  );
});

app.post('/t/:tenant/signon', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = getSession(req, res, t.id);
  const { opid, pw, next } = req.body as Record<string, string>;
  if (opid !== DEMO_OPERATOR.id || pw !== DEMO_OPERATOR.password) {
    return res.redirect(base(t) + '/signon?bad=1');
  }
  s.operator = opid;
  s.seenDisclosure = false;
  return res.redirect(next && next.startsWith(base(t)) ? next : base(t) + '/');
});

function requireSession(req: Request, res: Response, t: TenantConfig): Session | null {
  const s = getSession(req, res, t.id);
  if (fire('expire')) s.operator = null;
  if (!s.operator) {
    res.redirect(base(t) + '/signon?expired=1&next=' + encodeURIComponent(req.originalUrl));
    return null;
  }
  return s;
}

/* ---------------------------- frameset ---------------------------- */

app.get('/t/:tenant/', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = getSession(req, res, t.id);
  if (!s.operator) return res.redirect(base(t) + '/signon');
  // A real frameset: two independent documents, no SPA router, no history API.
  return res.type('html').send(
    '<!DOCTYPE html><html><head><title>' +
      t.institution +
      ' - MemberLink</title></head>' +
      '<frameset cols="170,*" border="1">' +
      '<frame name="navFrame" src="' +
      base(t) +
      '/frames/nav" scrolling="no">' +
      '<frame name="mainFrame" src="' +
      base(t) +
      '/frames/main">' +
      '</frameset><noframes><body>This application requires frame support.</body></noframes></html>',
  );
});

app.get('/t/:tenant/frames/nav', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const b = base(t);
  return res.type('html').send(
    '<!DOCTYPE html><html><head><title>Navigation</title><style>' +
      'body{font-family:Verdana;font-size:11px;background:' +
      t.theme.accent +
      ';margin:0}td{padding:4px 6px}a{color:#1a3e8c;text-decoration:none}a:hover{text-decoration:underline}' +
      '</style></head><body><table cellpadding="0" cellspacing="0">' +
      '<tr><td><a href="' + b + '/frames/main" target="mainFrame">Home</a></td></tr>' +
      '<tr><td><a href="' + b + '/search" target="mainFrame">' + t.terms.subject + ' Search</a></td></tr>' +
      '<tr><td><a href="' + b + '/reports" target="mainFrame">Reports</a></td></tr>' +
      '<tr><td><a href="' + b + '/signoff" target="_top">Sign Off</a></td></tr>' +
      '</table></body></html>',
  );
});

app.get('/t/:tenant/frames/main', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;
  if (t.alwaysInterstitial && !s.seenDisclosure) {
    return res.redirect(base(t) + '/disclosure?next=' + encodeURIComponent(base(t) + '/frames/main'));
  }
  return res
    .type('html')
    .send(
      chrome(t, 'Home', '<h2>Welcome, operator ' + s.operator + '</h2><p style="margin:10px">Select a function from the navigation panel.</p>'),
    );
});

app.get('/t/:tenant/reports', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  if (!requireSession(req, res, t)) return;
  return res.type('html').send(chrome(t, 'Reports', '<div class="warn">No reports are scheduled.</div>'));
});

app.get('/t/:tenant/signoff', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = getSession(req, res, t.id);
  s.operator = null;
  return res.redirect(base(t) + '/signon');
});

/** Harbor's post-sign-on disclosure: an interstitial that is part of normal operation. */
app.get('/t/:tenant/disclosure', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  getSession(req, res, t.id);
  const next = String(req.query.next ?? base(t) + '/frames/main');
  return res.type('html').send(
    chrome(
      t,
      'Disclosure',
      '<div class="warn"><b>Notice.</b> Activity in this system is monitored and recorded.</div>' +
        '<form method="post" action="' +
        base(t) +
        '/disclosure"><input type="hidden" name="next" value="' +
        escapeAttr(next) +
        '"><div style="margin:10px"><input type="submit" value="Acknowledge"></div></form>',
    ),
  );
});

app.post('/t/:tenant/disclosure', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = getSession(req, res, t.id);
  s.seenDisclosure = true;
  const next = String((req.body as Record<string, string>).next ?? base(t) + '/frames/main');
  return res.redirect(next.startsWith(base(t)) ? next : base(t) + '/frames/main');
});

/** Unexpected maintenance notice — the "surprise interstitial" class of interruption. */
app.get('/t/:tenant/maintenance', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const next = String(req.query.next ?? base(t) + '/search');
  return res.type('html').send(
    chrome(
      t,
      'System Maintenance Notice',
      '<div class="warn"><b>Scheduled maintenance.</b> This instance will be unavailable Sunday 02:00-04:00 ET.</div>' +
        '<form method="get" action="' +
        (next.split('?')[0] ?? next) +
        '"><div style="margin:10px"><input type="submit" value="Continue"></div></form>',
    ),
  );
});

/* ------------------------- member search -------------------------- */

function searchPage(t: TenantConfig, banner: string): string {
  return chrome(
    t,
    t.terms.subject + ' Search',
    banner +
      '<form method="post" action="' +
      base(t) +
      '/search"><table class="form">' +
      '<tr><td>' +
      t.terms.subject +
      ' Number:</td><td><input type="text" name="mbr_no" size="10" maxlength="6"></td></tr>' +
      '<tr><td>Last Name:</td><td><input type="text" name="lname" size="20"></td></tr>' +
      '<tr><td></td><td><input type="submit" value="' +
      t.terms.searchButton +
      '">&nbsp;<input type="reset" value="Clear"></td></tr>' +
      '</table></form>',
  );
}

app.get('/t/:tenant/search', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;
  if (fire('interstitial')) {
    return res.redirect(base(t) + '/maintenance?next=' + encodeURIComponent(base(t) + '/search'));
  }
  return res.type('html').send(searchPage(t, ''));
});

app.post('/t/:tenant/search', async (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;

  if (fire('apperror')) {
    return res
      .status(500)
      .type('html')
      .send(
        chrome(
          t,
          'System Error',
          '<div class="err">Unexpected system error. Reference SYS-0x5A21. Contact the service desk if this persists.</div>',
        ),
      );
  }
  if (fire('slow')) await sleep(4500);

  const raw = String((req.body as Record<string, string>).mbr_no ?? '').trim();

  if (!/^\d{6}$/.test(raw)) {
    return res.type('html').send(searchPage(t, '<div class="err">' + t.terms.subject + ' number must be exactly 6 digits.</div>'));
  }
  const m = MEMBERS[raw];
  if (!m) {
    return res
      .type('html')
      .send(searchPage(t, '<div class="err">No ' + t.terms.subject.toLowerCase() + ' record found for ' + raw + '.</div>'));
  }
  if (m.restricted) {
    return res.type('html').send(
      chrome(
        t,
        'Access Denied',
        '<div class="err">Access denied. Operator ' +
          s.operator +
          ' is not authorized to view this ' +
          t.terms.subject.toLowerCase() +
          ' record.</div>',
      ),
    );
  }
  return res.redirect(base(t) + '/member/' + raw);
});

/* -------------------------- member detail ------------------------- */

app.get('/t/:tenant/member/:id', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;
  const m = MEMBERS[String(req.params.id)];
  if (!m || m.restricted) {
    return res.type('html').send(searchPage(t, '<div class="err">No ' + t.terms.subject.toLowerCase() + ' record found.</div>'));
  }
  const rows = m.accounts
    .map(
      (a) =>
        '<tr><td>' + a.number + '</td><td>' + a.type + '</td><td>' + a.status + '</td><td align="right">' + money(a.balance) + '</td></tr>',
    )
    .join('');
  const b = base(t);
  return res.type('html').send(
    chrome(
      t,
      t.terms.subject + ' Detail',
      '<table class="form">' +
        '<tr><td>' + t.terms.subject + ' Number:</td><td><b>' + m.number + '</b></td><td width="30"></td><td>Branch:</td><td>' + m.branch + '</td></tr>' +
        '<tr><td>Name:</td><td><b>' + m.name + '</b></td><td></td><td>' + t.terms.subject + ' Since:</td><td>' + m.since + '</td></tr>' +
        '</table><h2>Accounts</h2><table class="grid">' +
        '<tr><th>Acct</th><th>Type</th><th>Status</th><th>' + t.terms.balanceLabel + '</th></tr>' +
        rows +
        '</table><div style="margin:10px">' +
        '<a href="' + b + '/member/' + m.number + '/subaccount">Open Sub-Account</a>&nbsp;|&nbsp;' +
        '<a href="' + b + '/member/' + m.number + '/close">Close ' + t.terms.subject + ' Relationship</a>&nbsp;|&nbsp;' +
        '<a href="' + b + '/search">New ' + t.terms.searchButton + '</a></div>',
    ),
  );
});

/* ------------------- sub-account open (write flow) ----------------- */

function subAccountForm(t: TenantConfig, id: string, name: string, banner: string): string {
  return chrome(
    t,
    'Open Sub-Account',
    banner +
      '<table class="form"><tr><td>' + t.terms.subject + ':</td><td><b>' + id + ' &#183; ' + name + '</b></td></tr></table>' +
      '<form method="post" action="/t/' + t.id + '/member/' + id + '/subaccount"><table class="form">' +
      '<tr><td>Account Type:</td><td><select name="acct_type">' +
      '<option value="">-- select --</option>' +
      '<option value="SHARE SAVINGS">SHARE SAVINGS</option>' +
      '<option value="VACATION CLUB">VACATION CLUB</option>' +
      '<option value="CERTIFICATE">CERTIFICATE</option>' +
      '</select></td></tr>' +
      '<tr><td>Opening Deposit:</td><td><input type="text" name="deposit" size="12"></td></tr>' +
      '<tr><td></td><td><input type="submit" value="Submit"></td></tr>' +
      '</table></form>',
  );
}

function confirmationPage(t: TenantConfig, id: string, name: string, type: string, deposit: number): string {
  const ref = 'SA-' + (100000 + (Number(id) % 100000)).toString();
  return chrome(
    t,
    'Sub-Account Confirmation',
    '<div class="ok"><b>Review and confirm.</b> No account has been opened yet.</div>' +
      '<table class="grid"><tr><th>Field</th><th>Value</th></tr>' +
      '<tr><td>' + t.terms.subject + '</td><td>' + id + ' &#183; ' + name + '</td></tr>' +
      '<tr><td>Account Type</td><td>' + type + '</td></tr>' +
      '<tr><td>Opening Deposit</td><td>' + money(deposit) + '</td></tr>' +
      '<tr><td>Reference</td><td>' + ref + '</td></tr></table>' +
      '<div style="margin:10px"><form method="post" action="/t/' + t.id + '/member/' + id + '/commit" style="display:inline">' +
      '<input type="hidden" name="acct_type" value="' + escapeAttr(type) + '">' +
      '<input type="hidden" name="deposit" value="' + escapeAttr(String(deposit)) + '">' +
      '<input type="submit" value="Confirm and Post"></form>&nbsp;<a href="/t/' + t.id + '/member/' + id + '">Cancel</a></div>',
  );
}

app.get('/t/:tenant/member/:id/subaccount', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  if (!requireSession(req, res, t)) return;
  const m = MEMBERS[String(req.params.id)];
  if (!m) return res.type('html').send(searchPage(t, '<div class="err">No record found.</div>'));
  return res.type('html').send(subAccountForm(t, m.number, m.name, ''));
});

app.post('/t/:tenant/member/:id/subaccount', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;
  const m = MEMBERS[String(req.params.id)];
  if (!m) return res.type('html').send(searchPage(t, '<div class="err">No record found.</div>'));
  const body = req.body as Record<string, string>;
  const type = String(body.acct_type ?? '');
  const deposit = Number(String(body.deposit ?? '').replace(/[$,]/g, ''));

  if (!type) {
    return res.type('html').send(subAccountForm(t, m.number, m.name, '<div class="err">Account type is required.</div>'));
  }
  if (!Number.isFinite(deposit) || deposit < 0) {
    return res.type('html').send(subAccountForm(t, m.number, m.name, '<div class="err">Opening deposit is not a valid amount.</div>'));
  }

  // Supervisor override: a real-world gate the automation cannot satisfy on its own.
  if (deposit >= OVERRIDE_THRESHOLD && !s.overrideGranted) {
    return res.type('html').send(
      chrome(
        t,
        'Supervisor Override Required',
        '<div class="warn"><b>Supervisor override required.</b> Opening deposits of ' +
          money(OVERRIDE_THRESHOLD) +
          ' or more must be authorized by a supervisor. Enter the override code to continue.</div>' +
          '<form method="post" action="/t/' + t.id + '/member/' + m.number + '/override">' +
          '<input type="hidden" name="acct_type" value="' + escapeAttr(type) + '">' +
          '<input type="hidden" name="deposit" value="' + escapeAttr(String(deposit)) + '">' +
          '<table class="form"><tr><td>Override Code:</td><td><input type="password" name="code" size="8"></td></tr>' +
          '<tr><td></td><td><input type="submit" value="Authorize"></td></tr></table></form>',
      ),
    );
  }
  return res.type('html').send(confirmationPage(t, m.number, m.name, type, deposit));
});

app.post('/t/:tenant/member/:id/override', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  const s = requireSession(req, res, t);
  if (!s) return;
  const m = MEMBERS[String(req.params.id)];
  if (!m) return res.type('html').send(searchPage(t, '<div class="err">No record found.</div>'));
  const body = req.body as Record<string, string>;
  if (String(body.code ?? '') !== OVERRIDE_CODE) {
    return res
      .type('html')
      .send(
        chrome(
          t,
          'Supervisor Override Required',
          '<div class="err">Override code rejected.</div><div style="margin:10px"><a href="/t/' +
            t.id +
            '/member/' +
            m.number +
            '/subaccount">Return to Open Sub-Account</a></div>',
        ),
      );
  }
  s.overrideGranted = true;
  return res
    .type('html')
    .send(confirmationPage(t, m.number, m.name, String(body.acct_type ?? ''), Number(body.deposit ?? '0')));
});

app.post('/t/:tenant/member/:id/commit', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  if (!requireSession(req, res, t)) return;
  const m = MEMBERS[String(req.params.id)];
  if (!m) return res.type('html').send(searchPage(t, '<div class="err">No record found.</div>'));
  const body = req.body as Record<string, string>;
  const type = String(body.acct_type ?? '');
  const deposit = Number(String(body.deposit ?? '0').replace(/[$,]/g, ''));

  // The post actually posts. Nothing here deduplicates: committing the same
  // sub-account twice appends a SECOND row, and the member's detail screen
  // shows both. An automation that re-runs after an ambiguous failure must
  // therefore prevent the double-post itself — which is the whole point of
  // declaring an idempotency guard in the artifact. A target app that
  // quietly swallowed the duplicate would make a broken automation look fine.
  const number = String(1 + m.accounts.length).padStart(4, '0');
  m.accounts.push({ number, type: type || 'VACATION CLUB', balance: Number.isFinite(deposit) ? deposit : 0, status: 'OPEN' });
  const ref = 'SA-' + (100000 + (Number(m.number) % 100000)).toString();

  return res.type('html').send(
    chrome(
      t,
      'Posted',
      '<div class="ok">Sub-account posted. Reference ' + ref + '.</div>' +
        '<table class="grid"><tr><th>Field</th><th>Value</th></tr>' +
        '<tr><td>Account</td><td>' + number + '</td></tr>' +
        '<tr><td>Account Type</td><td>' + escapeAttr(type) + '</td></tr>' +
        '<tr><td>Status</td><td>OPEN</td></tr></table>' +
        '<div style="margin:10px"><a href="' + base(t) + '/member/' + m.number + '">Back to ' + t.terms.subject + ' Detail</a></div>',
    ),
  );
});

/* --------------------- irreversible action ------------------------ */

app.get('/t/:tenant/member/:id/close', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  if (!requireSession(req, res, t)) return;
  const id = String(req.params.id);
  return res.type('html').send(
    chrome(
      t,
      'Close Relationship',
      '<div class="err"><b>Irreversible.</b> Closing a relationship cannot be undone and will purge account history after 30 days.</div>' +
        '<form method="post" action="/t/' + t.id + '/member/' + id + '/close">' +
        '<div style="margin:10px"><input type="submit" value="Close Relationship Permanently"></div></form>',
    ),
  );
});

app.post('/t/:tenant/member/:id/close', (req, res) => {
  const t = tenantOr404(req.params.tenant);
  if (!t) return res.status(404).send('unknown tenant');
  if (!requireSession(req, res, t)) return;
  return res.type('html').send(chrome(t, 'Closed', '<div class="err">Relationship closed.</div>'));
});

/* ------------------------------------------------------------------ */

app.use((_req, res) => res.status(404).type('html').send('<h3>404</h3>'));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).type('html').send('<h3>500</h3><pre>' + err.message + '</pre>');
});

const PORT = Number(process.env.TARGET_APP_PORT ?? 4173);

export function start(port = PORT): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve({
        url: 'http://127.0.0.1:' + port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('target-app/server.ts')) {
  start().then(({ url }) => console.log('[target-app] MemberLink training instance on ' + url));
}
