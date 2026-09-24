import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../target-app/server.js';
import { replay } from '../src/replay/engine.js';
import { lookupFixture } from './fixtures/lookup.fixture.js';
import { applyOverlay } from '../src/artifact/overlay.js';
import { EscalationBroker } from '../src/escalation/broker.js';
import { OperatorConsole } from '../src/escalation/operator-console.js';
import { runAutoOperator } from '../src/escalation/auto-operator.js';
import { Redactor } from '../src/policy/redaction.js';
import { CapabilityStore } from '../src/artifact/store.js';

/**
 * End-to-end coverage of the production execution path, against the real
 * hostile surface, with no model involved. Every assertion here is a claim the
 * write-up makes, made checkable.
 */

const PORT = 4188;
const BASE = `http://127.0.0.1:${PORT}`;
let stop: () => Promise<void>;
let evidenceRoot: string;

const env = () => ({
  baseUrl: BASE,
  secret_OPERATOR_ID: 'OPR001',
  secret_OPERATOR_PASSWORD: 'training-only',
});

/** The fixture is pinned to /t/summit; point its allowlist at the test port. */
function fixture(...args: Parameters<typeof lookupFixture>) {
  const cap = lookupFixture(...args);
  cap.policy = { ...cap.policy, allowedOrigins: [`${BASE}/t/summit`] };
  return cap;
}

async function arm(mode: string, tenant = 'summit'): Promise<void> {
  await fetch(`${BASE}/t/${tenant}/__chaos?mode=${mode}`);
}

beforeAll(async () => {
  const s = await start(PORT);
  stop = s.close;
  evidenceRoot = mkdtempSync(join(tmpdir(), 'cua-evidence-'));
}, 60_000);

afterAll(async () => {
  await arm('none');
  await stop?.();
});

describe('replay — success', () => {
  it('completes the goal and returns typed outputs', async () => {
    const r = await replay({ capability: fixture(), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.memberName).toBe('DELACROIX, RENE J');
    expect(r.outputs.savingsBalance).toBe(4820.15);
    expect(r.stepsAttempted).toBe(9);
    expect(r.drift).toEqual([]);
  }, 90_000);

  it('never writes financial or PII values into the evidence file', async () => {
    const r = await replay({ capability: fixture(), inputs: { memberId: '345678' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    const log = readFileSync(join(r.evidenceDir, 'run.jsonl'), 'utf8');
    const result = readFileSync(join(r.evidenceDir, 'result.json'), 'utf8');
    for (const secret of ['HALVORSEN, PETRA M', '78244.02', '78,244.02', 'training-only', '345678']) {
      expect(log, `"${secret}" leaked into run.jsonl`).not.toContain(secret);
      expect(result, `"${secret}" leaked into result.json`).not.toContain(secret);
    }
    // ...while still returning them to the caller.
    if (r.status === 'success') expect(r.outputs.memberName).toBe('HALVORSEN, PETRA M');
  }, 90_000);
});

describe('replay — business outcomes are answers, not failures', () => {
  it('reports a missing member as a business outcome', async () => {
    const r = await replay({ capability: fixture(), inputs: { memberId: '000000' }, env: env(), evidenceRoot });
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.code).toBe('MEMBER_NOT_FOUND');
    // The message is rendered from the caller's own input.
    expect(r.outcome.message).toContain('000000');
  }, 90_000);

  it('reports a permission denial as a business outcome, not a crash', async () => {
    const r = await replay({ capability: fixture(), inputs: { memberId: '999999' }, env: env(), evidenceRoot });
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.code).toBe('MEMBER_RESTRICTED');
  }, 90_000);
});

describe('replay — recoverable conditions', () => {
  it('waits out a transient slow response instead of failing', async () => {
    await arm('slow');
    const r = await replay({ capability: fixture(), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    expect(r.durationMs).toBeGreaterThan(4000);
  }, 90_000);

  it('clears an unexpected maintenance interstitial via a declared recovery rule', async () => {
    await arm('interstitial');
    const r = await replay({ capability: fixture(), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    expect(r.recoveries.map((x) => x.ruleId)).toContain('dismiss-maintenance-notice');
  }, 90_000);

  it('re-authenticates after the session expires mid-run', async () => {
    await arm('expire');
    const r = await replay({ capability: fixture(), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    expect(r.recoveries.map((x) => x.ruleId)).toContain('re-authenticate');
  }, 90_000);
});

describe('replay — hard failures', () => {
  it('classifies an application error page as app_error, with debuggable detail', async () => {
    await arm('apperror');
    const r = await replay({ capability: fixture(), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error.category).toBe('app_error');
    expect(r.error.retryable).toBe(true);
    expect(r.error.stepId).toBe('s07-click');
    expect(r.error.expected).toBeTruthy();
    expect(r.error.observed).toBeTruthy();
    expect(r.error.evidence.screenshotPath).toBeTruthy();
    expect(r.error.evidence.snapshotPath).toBeTruthy();
  }, 90_000);

  it('rejects malformed input without opening a browser', async () => {
    const t0 = Date.now();
    const r = await replay({ capability: fixture(), inputs: { memberId: 'not-a-number' }, env: env(), evidenceRoot });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error.category).toBe('input_validation');
    expect(r.error.retryable).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 30_000);

  it('refuses to replay a draft capability unattended', async () => {
    const r = await replay({ capability: fixture({ state: 'draft' }), inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error.category).toBe('policy_denied');
  }, 30_000);

  it('reports an unresolvable locator with a per-strategy diagnosis', async () => {
    const cap = fixture();
    (cap.steps[5]!.action as { target: { strategies: unknown[] } }).target.strategies = [
      { kind: 'fieldName', name: 'no_such_field', tier: 'structural' },
    ];
    const r = await replay({ capability: cap, inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(['locator_unresolved', 'action_failed']).toContain(r.error.category);
    expect(r.error.stepId).toBe('s06-fill');
  }, 90_000);
});

describe('replay — cross-tenant reuse', () => {
  it('runs the same artifact against a second institution via a vocabulary overlay', async () => {
    const base = fixture();
    const withOverlay = {
      ...base,
      tenantOverlays: [
        {
          tenantId: 'harbor',
          institution: 'Harbor First Bank',
          entry: '{{env.baseUrl}}/t/harbor/',
          allowedOrigins: [`${BASE}/t/harbor`],
          terms: {
            'Member Search': 'Customer Search',
            'Member Detail': 'Customer Detail',
            'Member Number': 'Customer Number',
            'Current Balance': 'Available Balance',
            Member: 'Customer',
            member: 'customer',
            Search: 'Find',
          },
          locatorOverrides: {},
          extraRecovery: [],
          extraOutcomes: [],
        },
      ],
    };
    const resolved = applyOverlay(withOverlay, withOverlay.tenantOverlays[0]!);

    // The overlay alone must re-point the run. This used to be patched by hand
    // here — which meant the test passed while `--tenant harbor` drove Summit
    // and reported another institution's balance as success.
    expect((resolved.steps[0]!.action as { url: string }).url).toBe('{{env.baseUrl}}/t/harbor/');
    expect(resolved.policy.allowedOrigins).toEqual([`${BASE}/t/harbor`]);

    const r = await replay({ capability: resolved, inputs: { memberId: '123456' }, env: env(), evidenceRoot });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.savingsBalance).toBe(4820.15);
    // Harbor interposes a disclosure after sign-on; the app-level rule clears
    // it. This assertion is the tenant proof: on Summit it cannot fire.
    expect(r.recoveries.map((x) => x.ruleId)).toContain('acknowledge-disclosure');
  }, 90_000);
});

describe('the artifacts that actually ship', () => {
  // Every other integration test drives `lookupFixture`, a hand-written
  // capability. That proves the engine and leaves the recorder→artifact→replay
  // link — the thing a reviewer runs — unguarded.
  const store = new CapabilityStore(join(__dirname, '..', 'capabilities'));

  function shipped(id: string) {
    const cap = store.load(id);
    cap.policy = { ...cap.policy, allowedOrigins: [`${BASE}/t/summit`, `${BASE}/t/harbor`] };
    return cap;
  }

  it('replays the recorded balance lookup', async () => {
    const r = await replay({
      capability: shipped('memberlink.lookup-member-balance'),
      inputs: { memberId: '123456' },
      env: env(),
      evidenceRoot,
    });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.memberName).toBe('DELACROIX, RENE J');
    expect(r.outputs.savingsBalance).toBe(4820.15);
  }, 90_000);

  it('reaches the confirmation screen on the recorded write capability', async () => {
    // Pinned. An unversioned id resolves to the newest version, and 1.1.0 posts.
    const r = await replay({
      capability: shipped('memberlink.open-sub-account@1.0.0'),
      inputs: { memberId: '123456', accountType: 'VACATION CLUB', openingDeposit: 250 },
      env: env(),
      evidenceRoot,
    });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.reference).toBe('SA-123456');
  }, 90_000);

  it('refuses the irreversible post when no escalation channel is configured', async () => {
    // Nobody to ask means the step does not happen. Acting because no human was
    // reachable is the one outcome that must never be possible for a step that
    // moves money.
    const r = await replay({
      capability: shipped('memberlink.open-sub-account@1.1.0'),
      inputs: { memberId: '345678', accountType: 'CERTIFICATE', openingDeposit: 100 },
      env: env(),
      evidenceRoot,
    });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error.category).toBe('policy_denied');
    expect(r.error.stepId).toBe('s13-click');
    expect(r.error.retryable).toBe(false);
  }, 120_000);

  it('every shipped artifact is approved and carries proof on each write step', () => {
    for (const id of [
      'memberlink.lookup-member-balance',
      'memberlink.open-sub-account@1.0.0',
      'memberlink.open-sub-account@1.1.0',
    ]) {
      const cap = store.load(id);
      expect(cap.state).toBe('approved');
      for (const step of cap.steps) {
        if (step.risk !== 'read') expect(step.checkpoint, `${cap.id} ${step.id}`).toBeTruthy();
      }
    }
  });
});

describe('the irreversible write — gated, performed, and not performed twice', () => {
  const store = new CapabilityStore(join(__dirname, '..', 'capabilities'));

  function posting() {
    const cap = store.load('memberlink.open-sub-account@1.1.0');
    cap.policy = { ...cap.policy, allowedOrigins: [`${BASE}/t/summit`] };
    return cap;
  }

  async function accountsOf(memberId: string): Promise<string[]> {
    const signon = await fetch(`${BASE}/t/summit/signon`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'opid=OPR001&pw=training-only',
      redirect: 'manual',
    });
    const cookie = signon.headers.get('set-cookie')?.split(';')[0] ?? '';
    const html = await (await fetch(`${BASE}/t/summit/member/${memberId}`, { headers: { cookie } })).text();
    return [...html.matchAll(/<td>\d{4}<\/td><td>([A-Z ]+)<\/td>/g)].map((m) => m[1] as string);
  }

  async function runIt() {
    const broker = new EscalationBroker(evidenceRoot, new Redactor('t'));
    // Not 4190: that is on the WHATWG blocked-ports list ("sieve"), and Node's
    // fetch refuses it with "bad port", so the scripted operator would poll a
    // console it can never reach.
    const consoleSrv = new OperatorConsole(broker, 4191);
    await consoleSrv.start();
    // The supervisor waits for a ticket that may never come, so the run's end
    // is what stops it — exactly as the CLI does it.
    const done = new AbortController();
    const operator = runAutoOperator({
      consoleBaseUrl: consoleSrv.baseUrl,
      // The supervisor authorises; they do not press the button themselves, so
      // the engine still has to see the posted screen before calling it done.
      playbooks: [{ when: 'confirm and post', disposition: 'resume', notes: 'authorised' }],
      timeoutMs: 120_000,
      signal: done.signal,
    });
    const r = await replay({
      capability: posting(),
      inputs: { memberId: '123456', accountType: 'VACATION CLUB', openingDeposit: 250 },
      env: env(),
      evidenceRoot,
      escalation: { broker, consoleBaseUrl: consoleSrv.baseUrl, timeoutMs: 45_000 },
    });
    done.abort();
    await operator;
    await consoleSrv.stop();
    return r;
  }

  it('requires a human decision for the post, then actually opens the account', async () => {
    await fetch(`${BASE}/t/summit/__reset`);
    const before = await accountsOf('123456');

    const r = await runIt();

    expect(r.status).toBe('success');
    expect(r.escalations).toHaveLength(1);
    expect(r.escalations[0]!.reason).toBe('confirmation_required');
    expect(r.escalations[0]!.disposition).toBe('resume');

    // The account exists afterwards. Without this the capability could "succeed"
    // against a confirmation screen that opens nothing, which is what it did
    // before this version.
    const after = await accountsOf('123456');
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContain('VACATION CLUB');
  }, 180_000);

  it('reports SUB_ACCOUNT_EXISTS on a re-run instead of posting a second one', async () => {
    // The state left by the previous test is the point: this is the caller
    // retrying an operation that already landed.
    const before = await accountsOf('123456');
    expect(before).toContain('VACATION CLUB');

    const r = await runIt();

    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.code).toBe('SUB_ACCOUNT_EXISTS');
    // No human was troubled, because nothing needed deciding.
    expect(r.escalations).toEqual([]);

    const after = await accountsOf('123456');
    expect(after).toEqual(before);
  }, 180_000);

  it('the target application does not deduplicate — the guard is doing the work', async () => {
    // If the app quietly swallowed a duplicate post, the test above would pass
    // with the guard deleted, and the guarantee would be fictional.
    const before = await accountsOf('123456');
    const signon = await fetch(`${BASE}/t/summit/signon`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'opid=OPR001&pw=training-only',
      redirect: 'manual',
    });
    const cookie = signon.headers.get('set-cookie')?.split(';')[0] ?? '';
    await fetch(`${BASE}/t/summit/member/123456/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'acct_type=VACATION+CLUB&deposit=250',
    });
    const after = await accountsOf('123456');
    expect(after).toHaveLength(before.length + 1);
    await fetch(`${BASE}/t/summit/__reset`);
  }, 60_000);
});

describe('escalation — control transfer over the real operator API', () => {
  it('hands the live session to a human, records what they did, and resumes', async () => {
    const broker = new EscalationBroker(evidenceRoot, new Redactor('t'));
    const consoleSrv = new OperatorConsole(broker, 4189);
    await consoleSrv.start();

    // Break one step so the run reaches a state it cannot recognise.
    const cap = fixture();
    cap.steps[6]!.checkpoint = { kind: 'textPresent', value: 'Underwriting Queue', match: 'contains', framePath: ['mainFrame'] };

    const done = new AbortController();
    const operator = runAutoOperator({
      consoleBaseUrl: consoleSrv.baseUrl,
      // No playbook matches, so the scripted supervisor aborts — which is the
      // correct behaviour for an operator who does not recognise the screen.
      playbooks: [{ when: 'member detail', click: [], disposition: 'abort', notes: 'nothing to do here' }],
      timeoutMs: 60_000,
      signal: done.signal,
    });

    const r = await replay({
      capability: cap,
      inputs: { memberId: '123456' },
      env: env(),
      evidenceRoot,
      escalation: { broker, consoleBaseUrl: consoleSrv.baseUrl, timeoutMs: 45_000 },
    });

    done.abort();
    await operator;
    await consoleSrv.stop();

    expect(r.escalations).toHaveLength(1);
    expect(r.escalations[0]!.reason).toBe('unknown_state');
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.error.category).toBe('operator_aborted');

    // The transfer is in the evidence, both directions.
    const log = readFileSync(join(r.evidenceDir, 'run.jsonl'), 'utf8');
    expect(log).toContain('"to":"operator"');
    expect(log).toContain('"to":"automation"');
  }, 120_000);

  it('refuses to let automation act while an operator holds the session', async () => {
    const { SessionController } = await import('../src/escalation/session-control.js');
    const fake = { livePage: () => null } as never;
    const s = new SessionController(fake, 'run-1', 'http://x', 'in-process');
    expect(s.holder()).toBe('automation');
    await s.cedeToOperator('test');
    expect(s.holder()).toBe('operator');
    expect(() => s.assertHolder('automation')).toThrow(/control-transfer violation/);
    await s.reclaim();
    expect(s.holder()).toBe('automation');
    await expect(s.reclaim()).rejects.toThrow(/cannot reclaim/);
  });
});
