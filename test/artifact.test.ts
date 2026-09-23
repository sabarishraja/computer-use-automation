import { describe, it, expect } from 'vitest';
import {
  Capability,
  SCHEMA_VERSION,
  capabilityRisk,
  renderTemplate,
  validateCapability,
  type Capability as Cap,
} from '../src/artifact/schema.js';
import { applyOverlay } from '../src/artifact/overlay.js';
import { substituteTerms, localiseCondition, localiseLocator } from '../src/artifact/terms.js';

function baseCapability(over: Partial<Cap> = {}): Cap {
  return Capability.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'test.capability',
    version: '1.0.0',
    name: 'Test',
    description: 'A test capability.',
    state: 'approved',
    surface: {
      kind: 'web',
      entry: '{{env.baseUrl}}/t/summit/',
      application: { vendor: 'memberlink', product: 'core-servicing', versionRange: '3.x' },
      viewport: { width: 1280, height: 800 },
    },
    inputs: [{ name: 'memberId', type: 'string', description: 'id', required: true, sensitivity: 'identifier' }],
    outputs: [{ name: 'balance', type: 'money', description: 'bal', sensitivity: 'financial', required: true }],
    steps: [
      {
        id: 's01-fill',
        intent: 'Enter the member number',
        action: {
          type: 'fill',
          target: {
            description: 'Member Number',
            framePath: ['mainFrame'],
            strategies: [{ kind: 'nearText', anchor: 'Member Number:', anchorMatch: 'exact', direction: 'following', control: 'textbox', ordinal: 1, tier: 'structural' }],
          },
          value: '{{inputs.memberId}}',
        },
        risk: 'read',
      },
      {
        id: 's02-extract',
        intent: 'Read the balance',
        action: {
          type: 'extract',
          field: 'balance',
          target: {
            description: 'SHARE SAVINGS balance',
            framePath: ['mainFrame'],
            strategies: [{ kind: 'tableCell', rowContains: 'SHARE SAVINGS', column: 'Current Balance', tier: 'positional' }],
          },
          transform: { kind: 'money' },
        },
        risk: 'read',
      },
    ],
    outcomes: [
      {
        code: 'MEMBER_NOT_FOUND',
        description: 'no such member',
        message: 'No member record exists for {{inputs.memberId}}.',
        when: { kind: 'textPresent', value: 'No member record found', match: 'contains' },
        partialOutputs: [],
      },
    ],
    successCondition: { kind: 'textPresent', value: 'Member Detail', match: 'contains' },
    policy: {
      allowedOrigins: ['http://127.0.0.1:4173/t/summit'],
      allowedPathPrefixes: [],
      maxUnattendedRisk: 'read',
      neverPersist: ['balance'],
      requiresApprovalState: ['approved'],
    },
    provenance: { recordedAt: new Date().toISOString(), recordedBy: 'llm-discovery', goal: 'test', humanEditedSteps: [] },
    ...over,
  });
}

describe('capability validation', () => {
  it('accepts a coherent capability', () => {
    expect(validateCapability(baseCapability())).toEqual([]);
  });

  it('rejects an extract into an undeclared output', () => {
    const cap = baseCapability();
    (cap.steps[1]!.action as { field: string }).field = 'notDeclared';
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join()).toMatch(/undeclared output "notDeclared"/);
  });

  it('rejects a required output that no step extracts', () => {
    const cap = baseCapability();
    cap.steps = [cap.steps[0]!];
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join()).toMatch(/required output "balance" is never extracted/);
  });

  it('rejects a state-changing step with no checkpoint', () => {
    const cap = baseCapability();
    cap.steps[0]!.risk = 'write_reversible';
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join()).toMatch(/is write_reversible but has no checkpoint/);
  });

  it('rejects a reference to an unknown input', () => {
    const cap = baseCapability();
    (cap.steps[0]!.action as { value: string }).value = '{{inputs.nope}}';
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join()).toMatch(/unknown input "nope"/);
  });

  it('refuses to return a secret output', () => {
    const cap = baseCapability();
    cap.outputs[0]!.sensitivity = 'secret';
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    expect(errors.map((e) => e.message).join()).toMatch(/secrets must never be returned/);
  });

  it('warns when a target has only fragile strategies', () => {
    const cap = baseCapability();
    (cap.steps[0]!.action as { target: { strategies: unknown[] } }).target.strategies = [
      { kind: 'css', selector: '.x input', tier: 'fragile' },
    ];
    const warnings = validateCapability(cap).filter((i) => i.level === 'warning');
    expect(warnings.map((w) => w.message).join()).toMatch(/only fragile strategies/);
  });

  it('reports the highest risk present', () => {
    const cap = baseCapability();
    cap.steps[0]!.risk = 'write_irreversible';
    cap.steps[0]!.checkpoint = { kind: 'textPresent', value: 'Posted', match: 'contains' };
    expect(capabilityRisk(cap)).toBe('write_irreversible');
  });
});

describe('templating', () => {
  it('substitutes inputs, outputs and env', () => {
    expect(renderTemplate('{{env.baseUrl}}/m/{{inputs.memberId}}', { env: { baseUrl: 'http://x' }, inputs: { memberId: '123456' } })).toBe(
      'http://x/m/123456',
    );
  });

  it('throws rather than substituting an empty string for a missing value', () => {
    expect(() => renderTemplate('{{inputs.missing}}', { inputs: {} })).toThrow(/not set/);
  });
});

describe('tenant vocabulary', () => {
  const terms = {
    'Member Search': 'Customer Search',
    'Member Detail': 'Customer Detail',
    'Current Balance': 'Available Balance',
    Member: 'Customer',
    Search: 'Find',
  };

  it('prefers the longest matching phrase', () => {
    expect(substituteTerms('Member Search', terms)).toBe('Customer Search');
    expect(substituteTerms('Search', terms)).toBe('Find');
    expect(substituteTerms('Member Number:', terms)).toBe('Customer Number:');
  });

  it('does not re-substitute its own output', () => {
    // "Member Search" -> "Customer Search" must not then become "Customer Find".
    expect(substituteTerms('Member Search', terms)).not.toContain('Find');
  });

  it('widens a condition rather than replacing it', () => {
    const c = localiseCondition({ kind: 'textPresent', value: 'Member Detail', match: 'contains' }, terms);
    expect(c.kind).toBe('any');
    const of = (c as { of: Array<{ value: string }> }).of;
    expect(of.map((x) => x.value)).toEqual(['Customer Detail', 'Member Detail']);
  });

  it('leaves a condition untouched when no term applies', () => {
    const original = { kind: 'textPresent', value: 'Posted', match: 'contains' } as const;
    expect(localiseCondition(original, terms)).toEqual(original);
  });

  it('prepends localised strategies and keeps the originals as fallback', () => {
    const loc = localiseLocator(
      {
        description: 'Search button',
        framePath: [],
        strategies: [{ kind: 'role', role: 'button', name: 'Search', match: 'exact', tier: 'semantic' }],
      },
      terms,
    );
    expect(loc.strategies).toHaveLength(2);
    expect((loc.strategies[0] as { name: string }).name).toBe('Find');
    expect((loc.strategies[1] as { name: string }).name).toBe('Search');
  });
});

describe('tenant overlays', () => {
  it('re-points entry and widens every locator and condition, without touching the step list', () => {
    const base = baseCapability();
    const resolved = applyOverlay(base, {
      tenantId: 'harbor',
      terms: { 'Member Number': 'Customer Number', 'Current Balance': 'Available Balance', 'Member Detail': 'Customer Detail' },
      entry: '{{env.baseUrl}}/t/harbor/',
      allowedOrigins: ['http://127.0.0.1:4173/t/harbor'],
      locatorOverrides: {},
      extraRecovery: [],
      extraOutcomes: [],
    });

    expect(resolved.steps).toHaveLength(base.steps.length);
    expect(resolved.steps.map((s) => s.id)).toEqual(base.steps.map((s) => s.id));
    expect(resolved.surface.entry).toBe('{{env.baseUrl}}/t/harbor/');
    // An overlay that moves the entry REPLACES the allowlist. Widening it was
    // what let a run asked for Harbor legally navigate to Summit and report
    // another institution's data as success.
    expect(resolved.policy.allowedOrigins).toEqual(['http://127.0.0.1:4173/t/harbor']);

    const fillTarget = (resolved.steps[0]!.action as { target: { strategies: Array<{ anchor?: string }> } }).target;
    expect(fillTarget.strategies[0]!.anchor).toBe('Customer Number:');
    expect(fillTarget.strategies[1]!.anchor).toBe('Member Number:');

    const cell = (resolved.steps[1]!.action as { target: { strategies: Array<{ column?: string }> } }).target;
    expect(cell.strategies[0]!.column).toBe('Available Balance');

    expect(resolved.successCondition.kind).toBe('any');
    // The resolved artifact must still be a valid capability.
    expect(validateCapability(resolved).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('is still a Capability the replay engine can consume unchanged', () => {
    const base = baseCapability();
    const resolved = applyOverlay(base, {
      tenantId: 'harbor',
      terms: { Member: 'Customer' },
      allowedOrigins: [],
      locatorOverrides: {},
      extraRecovery: [],
      extraOutcomes: [],
    });
    expect(() => Capability.parse(resolved)).not.toThrow();
  });
});
