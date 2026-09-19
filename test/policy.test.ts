import { describe, it, expect } from 'vitest';
import { PolicyEngine, DEFAULT_ACTION_TYPES, DEFAULT_IRREVERSIBLE_HINTS } from '../src/policy/guardrails.js';
import { Redactor } from '../src/policy/redaction.js';
import { inputSchema, coerceOutput, RETRYABLE } from '../src/replay/contract.js';

const engine = (over: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {}) =>
  new PolicyEngine({
    allowedOrigins: ['http://127.0.0.1:4173/t/summit'],
    allowedPathPrefixes: [],
    allowedActionTypes: DEFAULT_ACTION_TYPES,
    maxUnattendedRisk: 'read',
    irreversibleHints: DEFAULT_IRREVERSIBLE_HINTS,
    ...over,
  });

describe('allowlist', () => {
  it('allows a url under the permitted origin+path prefix', () => {
    expect(engine().checkUrl('http://127.0.0.1:4173/t/summit/search').effect).toBe('allow');
  });

  it('denies another tenant on the same origin', () => {
    const d = engine().checkUrl('http://127.0.0.1:4173/t/harbor/search');
    expect(d.effect).toBe('deny');
    expect(d).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('denies a different origin entirely', () => {
    expect(engine().checkUrl('https://evil.example/t/summit/search').effect).toBe('deny');
  });

  it('denies a non-absolute url', () => {
    expect(engine().checkUrl('/t/summit/search').effect).toBe('deny');
  });

  it('enforces path prefixes when configured', () => {
    const e = engine({ allowedOrigins: ['http://127.0.0.1:4173'], allowedPathPrefixes: ['/t/summit'] });
    expect(e.checkUrl('http://127.0.0.1:4173/t/summit/x').effect).toBe('allow');
    expect(e.checkUrl('http://127.0.0.1:4173/admin').effect).toBe('deny');
  });
});

describe('risk gating', () => {
  const click = { type: 'click', target: { description: 'x', framePath: [], strategies: [{ kind: 'css', selector: 'a', tier: 'fragile' }] } } as never;

  it('allows a read action under a read budget', () => {
    expect(engine().checkAction(click, 'read', 'Search').effect).toBe('allow');
  });

  it('requires confirmation when the step risk exceeds the unattended budget', () => {
    const d = engine().checkAction(click, 'write_reversible', 'Submit');
    expect(d.effect).toBe('require_confirmation');
    expect(d).toMatchObject({ code: 'RISK_EXCEEDS_UNATTENDED' });
  });

  it('overrides a benign classification when the control label looks irreversible', () => {
    const d = engine({ maxUnattendedRisk: 'write_reversible' }).checkAction(click, 'read', 'Close Relationship Permanently');
    expect(d.effect).toBe('require_confirmation');
    expect(d).toMatchObject({ code: 'IRREVERSIBLE_CONTROL' });
  });

  it('refuses an action type that is not permitted at all', () => {
    const d = engine({ allowedActionTypes: ['navigate'] }).checkAction(click, 'read', 'Search');
    expect(d).toMatchObject({ effect: 'deny', code: 'ACTION_TYPE_NOT_ALLOWED' });
  });

  it('checks the allowlist on a navigate action, not only on checkUrl', () => {
    const d = engine().checkAction({ type: 'navigate', url: 'https://evil.example/' } as never, 'read');
    expect(d.effect).toBe('deny');
  });
});

describe('redaction', () => {
  it('scrubs a registered identifier consistently and reversibly correlates it', () => {
    const r = new Redactor('salt');
    r.register('123456', 'identifier');
    const a = r.text('looked up member 123456 ok');
    const b = r.text('member 123456 again');
    expect(a).not.toContain('123456');
    const token = a.match(/\[id:[0-9a-f]+\]/)?.[0];
    expect(token).toBeTruthy();
    expect(b).toContain(token!);
  });

  it('never emits a registered secret', () => {
    const r = new Redactor();
    r.register('training-only', 'secret');
    expect(r.text('typed training-only into the password box')).toBe('typed [redacted:secret] into the password box');
  });

  it('redacts a financial value found in free text', () => {
    const r = new Redactor();
    r.register('$4,820.15', 'financial');
    expect(r.text('balance is $4,820.15')).toBe('balance is [redacted:financial]');
  });

  it('catches an undeclared SSN by pattern', () => {
    expect(new Redactor().text('ssn 123-45-6789 on file')).toBe('ssn [redacted:ssn] on file');
  });

  it('does not mangle ordinary numbers as card numbers', () => {
    // Fails Luhn, so it must survive intact.
    expect(new Redactor().text('reference 1234567890123')).toContain('1234567890123');
  });

  it('deep-redacts nested objects but keeps keys', () => {
    const r = new Redactor();
    r.register('123456', 'identifier');
    const out = r.json({ step: 's01', detail: { input: '123456' } }) as { step: string; detail: { input: string } };
    expect(out.step).toBe('s01');
    expect(out.detail.input).not.toBe('123456');
  });

  it('returns financial data to the caller but not to evidence', () => {
    const r = new Redactor();
    const { forCaller, forEvidence } = r.partitionOutputs(
      { balance: 4820.15, branch: 'RIVERSIDE 002' },
      [
        { name: 'balance', sensitivity: 'financial' },
        { name: 'branch', sensitivity: 'public' },
      ],
      [],
    );
    expect(forCaller.balance).toBe(4820.15);
    expect(forEvidence.balance).toBe('[redacted:financial]');
    expect(forEvidence.branch).toBe('RIVERSIDE 002');
  });

  it('drops a secret output entirely rather than returning it', () => {
    const r = new Redactor();
    const { forCaller } = r.partitionOutputs({ token: 'abc123xyz' }, [{ name: 'token', sensitivity: 'secret' }], []);
    expect(forCaller).toEqual({});
  });
});

describe('input contract', () => {
  const schema = inputSchema([
    { name: 'memberId', type: 'string', description: '', required: true, sensitivity: 'identifier', pattern: '^\\d{6}$' },
    { name: 'amount', type: 'money', description: '', required: false, sensitivity: 'financial' },
  ]);

  it('accepts a valid input', () => {
    expect(schema.safeParse({ memberId: '123456' }).success).toBe(true);
  });

  it('rejects a pattern violation before any browser is opened', () => {
    const r = schema.safeParse({ memberId: 'abc' });
    expect(r.success).toBe(false);
  });

  it('rejects an unexpected parameter instead of silently ignoring it', () => {
    expect(schema.safeParse({ memberId: '123456', sneaky: 'x' }).success).toBe(false);
  });

  it('rejects a missing required parameter', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('coerces money, including negatives', () => {
    expect(coerceOutput('$4,820.15', 'money')).toBe(4820.15);
    expect(coerceOutput('-$11,204.00', 'money')).toBe(-11204);
  });
});

describe('failure taxonomy', () => {
  it('marks caller-fault and post-write failures as not retryable', () => {
    expect(RETRYABLE.input_validation).toBe(false);
    expect(RETRYABLE.policy_denied).toBe(false);
    expect(RETRYABLE.checkpoint_failed).toBe(false);
    expect(RETRYABLE.operator_aborted).toBe(false);
  });

  it('marks transient conditions as retryable', () => {
    expect(RETRYABLE.timeout).toBe(true);
    expect(RETRYABLE.app_error).toBe(true);
  });
});
