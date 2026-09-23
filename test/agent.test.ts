import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Recorder } from '../src/agent/recorder.js';
import { wasAlreadyPresent } from '../src/agent/loop.js';
import { CapabilitySpec } from '../src/agent/spec.js';
import type { ControlDescriptor, FrameObservation } from '../src/surface/types.js';

/**
 * ============================================================================
 * Recording invariants
 * ============================================================================
 *
 * `src/agent` had no direct coverage, and every bug that reached a committed
 * artifact lived here: a write step recorded without proof, a checkpoint whose
 * wording was already on the previous screen, an outcome detector carrying a
 * probe's member number. None of these need a model to reproduce — they need
 * the recorder driven by hand — so there was never a good reason for the gap.
 */

const spec = CapabilitySpec.parse(
  JSON.parse(readFileSync(resolve(__dirname, '..', 'capabilities', 'specs', 'memberlink.lookup-member-balance.json'), 'utf8')),
);

function recorder(inputs: Record<string, string> = { memberId: '123456' }): Recorder {
  return new Recorder(spec, 'http://127.0.0.1:4173', inputs, { OPERATOR_PASSWORD: 'training-only' });
}

function control(label: string, framePath: string[] = ['mainFrame']): ControlDescriptor {
  return {
    ref: 'c1',
    role: 'button',
    name: label,
    framePath,
    enabled: true,
    kind: 'interactive',
    candidateStrategies: [{ tier: 'semantic', kind: 'role', role: 'button', name: label, match: 'exact' }],
  };
}

function frame(name: string, text: string): FrameObservation {
  return { framePath: [name], url: 'http://127.0.0.1:4173/', title: '', ariaSnapshot: '', text };
}

describe('recorder — a write step must be proven', () => {
  it('reports a write click as unproven until it is checkpointed', () => {
    const r = recorder();
    r.recordClick(control('Submit'), 'submit the form');
    expect(r.unprovenWriteStep()?.risk).toBe('write_reversible');

    r.attachCheckpoint('Sub-Account Confirmation', ['mainFrame']);
    expect(r.unprovenWriteStep()).toBeUndefined();
  });

  it('does not demand proof of a read step', () => {
    const r = recorder();
    r.recordClick(control('Search'), 'search');
    expect(r.unprovenWriteStep()).toBeUndefined();
  });

  it('still finds an unproven write after later steps are recorded', () => {
    // The gate used to inspect only the last step, so one intervening step hid
    // the unproven write until save time and the whole recording was discarded.
    const r = recorder();
    r.recordClick(control('Submit'), 'submit');
    r.recordNavigate('http://127.0.0.1:4173/t/summit/');
    r.recordFill(control('Member Number'), '123456', 'enter member');

    const pending = r.unprovenWriteStep();
    expect(pending).toBeDefined();
    expect(pending?.id).toBe('s01-click');
  });
});

describe('recorder — proving text may not carry a value from the run', () => {
  it('rejects text containing an input value used in this phase', () => {
    expect(recorder().validateProvingText('No member record found for 123456')).toMatch(/must not contain/);
  });

  it('rejects text containing a PROBE value the recorder was not constructed with', () => {
    // Outcome discovery runs with probe inputs. Validating only against the
    // constructor's values let "No member record found for 000000." become a
    // detector that never fires for anyone else — a real answer reported as an
    // outage for every other member.
    const bad = recorder().validateProvingText('No member record found for 000000.', { memberId: '000000' });
    expect(bad).toMatch(/must not contain/);
  });

  it('accepts the static wording around the value', () => {
    expect(recorder().validateProvingText('No member record found', { memberId: '000000' })).toBeNull();
  });

  it('never allows a credential', () => {
    expect(recorder().validateProvingText('Signed on as training-only')).toMatch(/credential/);
  });
});

describe('recorder — risk comes from the control label, not the model', () => {
  const risk = (label: string): string => {
    const r = recorder();
    r.recordClick(control(label), 'x');
    return r.unprovenWriteStep() ? 'write' : 'read';
  };

  it('treats a query button as a read', () => {
    expect(risk('Search')).toBe('read');
    expect(risk('Find')).toBe('read');
  });

  it('treats a submitting button as a write needing proof', () => {
    expect(risk('Submit')).toBe('write');
    expect(risk('Save')).toBe('write');
  });
});

describe('checkpoint novelty is judged per frame', () => {
  const before = [frame('navFrame', 'Member Search | Transfer History | Sign Off'), frame('mainFrame', 'Member Detail Name: DELACROIX')];

  it('rejects wording that was already in the frame being checkpointed', () => {
    expect(wasAlreadyPresent(before, 'Member Detail', 'mainFrame')).toBe(true);
  });

  it('accepts wording new to that frame even when a sibling frame carries it', () => {
    // A frameset's nav frame shows "Member Search" on every screen. Judging
    // against every frame at once made that checkpoint unrecordable, which is
    // the shape the shipped fixture's own s05 checkpoint uses.
    expect(wasAlreadyPresent(before, 'Member Search', 'mainFrame')).toBe(false);
  });

  it('judges an unscoped checkpoint against every frame', () => {
    // Unscoped, the checkpoint holds if the text appears anywhere, so it proves
    // nothing when the text appeared anywhere before.
    expect(wasAlreadyPresent(before, 'Member Search', undefined)).toBe(true);
  });

  it('accepts genuinely new wording', () => {
    expect(wasAlreadyPresent(before, 'Opening Deposit:', 'mainFrame')).toBe(false);
  });

  it('treats a missing prior screen as no evidence rather than as proof', () => {
    expect(wasAlreadyPresent(null, 'anything', 'mainFrame')).toBe(false);
  });
});
