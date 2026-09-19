import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Capability, SCHEMA_VERSION, type Capability as Cap, type Locator } from '../../src/artifact/schema.js';
import { CapabilitySpec } from '../../src/agent/spec.js';

/**
 * A hand-written stand-in for the artifact discovery produces.
 *
 * It exists so the replay engine, the error taxonomy and the escalation path
 * are covered by tests that need no API key and no model — the whole point of
 * the design is that everything after discovery is deterministic, and a test
 * suite that could not run without a model would undercut that claim.
 *
 * It is built from the same spec file the real discovery run consumes, so the
 * app profile, policy and recovery rules are shared rather than duplicated.
 */
const spec = CapabilitySpec.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), 'capabilities/specs/memberlink.lookup-member-balance.json'), 'utf8')),
);

const main = (description: string, strategies: Locator['strategies']): Locator => ({ description, framePath: ['mainFrame'], strategies });
const nav = (description: string, strategies: Locator['strategies']): Locator => ({ description, framePath: ['navFrame'], strategies });
const top = (description: string, strategies: Locator['strategies']): Locator => ({ description, framePath: [], strategies });

export function lookupFixture(over: Partial<Cap> = {}): Cap {
  return Capability.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'memberlink.lookup-member-balance',
    version: '1.0.0',
    name: spec.name,
    description: spec.description,
    state: 'approved',
    surface: {
      kind: 'web',
      entry: spec.entry,
      application: spec.app.application,
      viewport: spec.app.viewport,
    },
    inputs: spec.inputs,
    outputs: spec.outputs,
    steps: [
      {
        id: 's01-navigate',
        intent: 'Open the MemberLink entry point',
        action: { type: 'navigate', url: '{{env.baseUrl}}/t/summit/' },
        risk: 'read',
        checkpoint: { kind: 'textPresent', value: 'Operator Sign-On', match: 'contains' },
        timeoutMs: 20000,
      },
      {
        id: 's02-fill',
        intent: 'Enter the operator ID',
        action: {
          type: 'fill',
          target: top('Operator ID', [
            { kind: 'nearText', anchor: 'Operator ID:', anchorMatch: 'exact', direction: 'following', control: 'textbox', ordinal: 1, tier: 'structural' },
            { kind: 'fieldName', name: 'opid', tier: 'structural' },
          ]),
          value: '{{env.secret_OPERATOR_ID}}',
        },
        risk: 'read',
      },
      {
        id: 's03-fill',
        intent: 'Enter the operator password',
        action: {
          type: 'fill',
          target: top('Password', [
            { kind: 'nearText', anchor: 'Password:', anchorMatch: 'exact', direction: 'following', control: 'textbox', ordinal: 1, tier: 'structural' },
            { kind: 'fieldName', name: 'pw', tier: 'structural' },
          ]),
          value: '{{env.secret_OPERATOR_PASSWORD}}',
        },
        risk: 'read',
      },
      {
        id: 's04-click',
        intent: 'Sign on',
        action: { type: 'click', target: top('Sign On', [{ kind: 'role', role: 'button', name: 'Sign On', match: 'exact', tier: 'semantic' }]) },
        risk: 'read',
        // Scoped to mainFrame: the nav frame is always present, so an
        // unscoped text checkpoint would pass on almost any screen.
        checkpoint: { kind: 'textPresent', value: 'Select a function from the navigation panel', match: 'contains', framePath: ['mainFrame'] },
        timeoutMs: 15000,
      },
      {
        id: 's05-click',
        intent: 'Open the member search screen',
        action: { type: 'click', target: nav('Member Search', [{ kind: 'role', role: 'link', name: 'Member Search', match: 'exact', tier: 'semantic' }]) },
        risk: 'read',
        checkpoint: { kind: 'textPresent', value: 'Member Search', match: 'contains', framePath: ['mainFrame'] },
        timeoutMs: 15000,
      },
      {
        id: 's06-fill',
        intent: 'Enter the member number',
        action: {
          type: 'fill',
          target: main('Member Number', [
            { kind: 'nearText', anchor: 'Member Number:', anchorMatch: 'exact', direction: 'following', control: 'textbox', ordinal: 1, tier: 'structural' },
            { kind: 'fieldName', name: 'mbr_no', tier: 'structural' },
          ]),
          value: '{{inputs.memberId}}',
        },
        risk: 'read',
      },
      {
        id: 's07-click',
        intent: 'Run the search',
        action: { type: 'click', target: main('Search', [{ kind: 'role', role: 'button', name: 'Search', match: 'exact', tier: 'semantic' }]) },
        risk: 'read',
        checkpoint: { kind: 'textPresent', value: 'Member Detail', match: 'contains', framePath: ['mainFrame'] },
        timeoutMs: 15000,
      },
      {
        id: 's08-extract',
        intent: "Read the member's name",
        action: {
          type: 'extract',
          field: 'memberName',
          target: main('Member name', [
            { kind: 'nearText', anchor: 'Name:', anchorMatch: 'exact', direction: 'following', control: 'cell', ordinal: 1, tier: 'structural' },
          ]),
          transform: { kind: 'trim' },
        },
        risk: 'read',
      },
      {
        id: 's09-extract',
        intent: 'Read the SHARE SAVINGS balance',
        action: {
          type: 'extract',
          field: 'savingsBalance',
          target: main('SHARE SAVINGS balance', [
            { kind: 'tableCell', rowContains: 'SHARE SAVINGS', column: 'Current Balance', tier: 'positional' },
            { kind: 'tableCell', rowContains: 'SHARE SAVINGS', column: 3, tier: 'positional' },
          ]),
          transform: { kind: 'money' },
        },
        risk: 'read',
      },
    ],
    outcomes: [
      {
        code: 'MEMBER_NOT_FOUND',
        description: spec.outcomes[0]!.description,
        message: spec.outcomes[0]!.message,
        partialOutputs: [],
        when: { kind: 'textPresent', value: 'No member record found', match: 'contains' },
      },
      {
        code: 'MEMBER_RESTRICTED',
        description: spec.outcomes[1]!.description,
        message: spec.outcomes[1]!.message,
        partialOutputs: [],
        when: { kind: 'textPresent', value: 'Access denied', match: 'contains' },
      },
    ],
    globalRecovery: spec.app.globalRecovery,
    successCondition: { kind: 'textPresent', value: 'Member Detail', match: 'contains', framePath: ['mainFrame'] },
    policy: spec.app.policy,
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: 'human',
      goal: spec.goal,
      humanEditedSteps: [],
    },
    tenantOverlays: [],
    ...over,
  });
}
