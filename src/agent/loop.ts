import Anthropic from '@anthropic-ai/sdk';
import { relative } from 'node:path';
import type { CapabilitySpec } from './spec.js';
import { Recorder, digest } from './recorder.js';
import { WebSurface } from '../surface/web-playwright.js';
import type { ControlDescriptor, Observation } from '../surface/types.js';
import { PolicyEngine } from '../policy/guardrails.js';
import { Redactor } from '../policy/redaction.js';
import { RunLogger } from '../evidence/run-log.js';
import type { Capability } from '../artifact/schema.js';
import { EscalationBroker } from '../escalation/broker.js';
import { SessionController } from '../escalation/session-control.js';

export const DEFAULT_MODEL = 'claude-opus-5';

export type DiscoveryOptions = {
  spec: CapabilitySpec;
  baseUrl: string;
  evidenceRoot: string;
  model?: string;
  headless?: boolean;
  /** envKey -> value. Registered as secrets; typed into the app, never stored. */
  credentials?: Record<string, string>;
  escalation?: { broker: EscalationBroker; consoleBaseUrl: string; timeoutMs: number };
};

export type DiscoveryResult =
  | { status: 'recorded'; capability: Capability; runId: string; evidenceDir: string; transcriptPath: string }
  | { status: 'failed'; reason: string; runId: string; evidenceDir: string };

/**
 * ============================================================================
 * Discovery: the LLM-driven observe → decide → act loop
 * ============================================================================
 *
 * A manual loop rather than the SDK tool runner, for reasons specific to this
 * problem: every tool call passes through the policy engine before it reaches
 * the browser, the recorder needs the resolved control (not the model's
 * arguments) to write a step, and the loop has to be able to stop and hand the
 * live session to a human mid-turn. Those are three interception points the
 * runner's per-turn hooks do not cleanly cover.
 *
 * What the model sees each turn is an accessibility snapshot plus a control
 * inventory — never raw HTML, never a CSS selector. It addresses controls by
 * ephemeral ref. That single constraint is why the recording is robust: the
 * model contributes judgement about *which control*, and the perception layer
 * contributes the ranked strategies for *finding it again*.
 *
 * Discovery runs in two phases:
 *   Phase 1  the happy path, producing the step list.
 *   Phase 2  one short run per declared business outcome, provoking it with
 *            the spec's probe inputs so its detector condition is observed
 *            rather than guessed. This is how the artifact learns the error
 *            taxonomy instead of having it hand-written.
 */
export async function discover(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const model = opts.model ?? process.env.CUA_MODEL ?? DEFAULT_MODEL;
  const spec = opts.spec;
  const redactor = new Redactor('discovery');
  const logger = new RunLogger(opts.evidenceRoot, 'discovery', redactor);
  const credentials = opts.credentials ?? {};

  for (const [, v] of Object.entries(credentials)) redactor.register(v, 'secret');
  const inputValues: Record<string, string> = {};
  for (const p of spec.inputs) {
    const v = spec.discoveryInputs[p.name];
    if (v !== undefined) {
      inputValues[p.name] = String(v);
      redactor.register(String(v), p.sensitivity);
    }
  }

  logger.log({ type: 'run.start', kind: 'discovery', goal: spec.goal, capability: `${spec.id}@${spec.version}`, inputs: inputValues });

  const client = new Anthropic();
  const policy = PolicyEngine.fromCapability({ policy: spec.app.policy } as Capability, {
    allowedOrigins: spec.app.policy.allowedOrigins,
    allowedPathPrefixes: spec.app.policy.allowedPathPrefixes,
    maxUnattendedRisk: spec.app.policy.maxUnattendedRisk,
  });

  const recorder = new Recorder(spec, opts.baseUrl, inputValues, credentials);
  const transcript: unknown[] = [];

  const surface = await WebSurface.launch({
    headless: opts.headless ?? true,
    viewport: spec.app.viewport,
    allowedOrigins: spec.app.policy.allowedOrigins,
  });

  const session = new SessionController(surface, logger.runId, opts.escalation?.consoleBaseUrl ?? 'http://127.0.0.1:0', 'in-process', (from, to, reason) =>
    logger.log({ type: 'control.transfer', from, to, reason }),
  );
  opts.escalation?.broker.registerSession(logger.runId, session);

  try {
    /* ------------------------- phase 1: happy path ------------------------ */
    const phase1 = await runPhase({
      client,
      model,
      surface,
      policy,
      recorder,
      logger,
      redactor,
      transcript,
      credentials,
      inputValues,
      maxSteps: spec.maxSteps,
      systemPrompt: happyPathSystemPrompt(spec, inputValues, credentials),
      firstUserMessage: `Goal: ${spec.goal}\n\nEntry point: ${opts.baseUrl}${entryPath(spec.entry)}\n\nBegin by calling observe.`,
      recordSteps: true,
      finishToolName: 'finish',
    });

    if (!phase1.ok) {
      // Discovery that cannot finish is exactly the case escalation exists for.
      if (opts.escalation) {
        const shot = await surface.screenshot(logger.shotPath('discovery-stuck'));
        await session.cedeToOperator('discovery_stuck');
        try {
          const res = await opts.escalation.broker.raise(
            {
              runId: logger.runId,
              capabilityId: spec.id,
              capabilityVersion: spec.version,
              goal: spec.goal,
              reason: 'discovery_stuck',
              detail: `Discovery could not complete the goal after ${phase1.steps} model turns. Last state: ${phase1.reason}`,
              askedOf: 'Inspect the session, and either demonstrate the remaining steps manually then release, or abort the recording.',
              url: await surface.currentUrl(),
              screenshot: shot ? relative(logger.dir, shot) : undefined,
              sessionEndpoint: 'in-process',
            },
            opts.escalation.timeoutMs,
          );
          logger.log({ type: 'escalation.resolved', ticketId: 'discovery', disposition: res.disposition, operatorActions: res.operatorActions.length });
          await session.reclaim();
        } catch (e) {
          logger.log({ type: 'run.end', status: 'failed', ms: logger.elapsedMs(), error: (e as Error).message });
          return { status: 'failed', reason: phase1.reason, runId: logger.runId, evidenceDir: logger.dir };
        }
      }
      logger.log({ type: 'run.end', status: 'failed', ms: logger.elapsedMs(), error: phase1.reason });
      return { status: 'failed', reason: phase1.reason, runId: logger.runId, evidenceDir: logger.dir };
    }

    /* --------------------- phase 2: outcome discovery --------------------- */
    for (const outcome of spec.outcomes) {
      const probe: Record<string, string> = {};
      for (const [k, v] of Object.entries(outcome.probeInputs)) probe[k] = String(v);

      await surface.perform({ type: 'navigate', url: opts.baseUrl + entryPath(spec.entry) }, 20_000);
      const r = await runPhase({
        client,
        model,
        surface,
        policy,
        recorder,
        logger,
        redactor,
        transcript,
        credentials,
        inputValues: probe,
        maxSteps: 12,
        systemPrompt: outcomeSystemPrompt(spec, outcome.code, outcome.description, probe, credentials),
        firstUserMessage:
          `Provoke the business outcome ${outcome.code} (${outcome.description}) using these values: ${JSON.stringify(probe)}.\n` +
          `Take the same route through the application as before, then call record_outcome. Begin by calling observe.`,
        recordSteps: false,
        finishToolName: 'record_outcome',
        outcomeCode: outcome.code,
      });
      logger.log({
        type: 'model.turn',
        index: -1,
        toolName: 'phase2:' + outcome.code,
        reasoning: r.ok ? 'outcome detector recorded' : `not recorded: ${r.reason}`,
      });
    }

    /* ------------------------------ build --------------------------------- */
    const { path: transcriptPath, digest: transcriptDigest } = logger.writeTranscript(transcript);
    const capability = recorder.build({ model, runId: logger.runId, transcriptDigest });
    logger.log({ type: 'run.end', status: 'recorded', ms: logger.elapsedMs() });
    return { status: 'recorded', capability, runId: logger.runId, evidenceDir: logger.dir, transcriptPath };
  } catch (e) {
    logger.writeTranscript(transcript);
    logger.log({ type: 'run.end', status: 'failed', ms: logger.elapsedMs(), error: (e as Error).message });
    return { status: 'failed', reason: (e as Error).message, runId: logger.runId, evidenceDir: logger.dir };
  } finally {
    await surface.close();
  }
}

/* -------------------------------------------------------------------------- */
/* One model-driven phase                                                      */
/* -------------------------------------------------------------------------- */

type PhaseArgs = {
  client: Anthropic;
  model: string;
  surface: WebSurface;
  policy: PolicyEngine;
  recorder: Recorder;
  logger: RunLogger;
  redactor: Redactor;
  transcript: unknown[];
  credentials: Record<string, string>;
  inputValues: Record<string, string>;
  maxSteps: number;
  systemPrompt: string;
  firstUserMessage: string;
  recordSteps: boolean;
  finishToolName: 'finish' | 'record_outcome';
  outcomeCode?: string;
};

async function runPhase(a: PhaseArgs): Promise<{ ok: true; steps: number } | { ok: false; reason: string; steps: number }> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: a.firstUserMessage }];
  let lastObservation: Observation | null = null;
  let turns = 0;

  while (turns < a.maxSteps) {
    turns++;

    const response = await a.client.messages
      .stream({
        model: a.model,
        max_tokens: 8000,
        // Adaptive thinking, summarised, so the evidence contains *why* the
        // agent acted and not only what it did. Requirement 3.5 asks for a
        // structured log of what the agent did AND why; this is the "why".
        thinking: { type: 'adaptive', display: 'summarized' },
        system: a.systemPrompt,
        tools: TOOLS,
        messages,
      })
      .finalMessage();

    const reasoning = response.content
      .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
      .map((b) => b.thinking)
      .join('\n')
      .slice(0, 2000);

    a.logger.log({
      type: 'model.turn',
      index: turns,
      reasoning: reasoning || undefined,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    });
    a.transcript.push({ turn: turns, role: 'assistant', stop_reason: response.stop_reason, content: response.content });

    if (response.stop_reason === 'refusal') {
      return { ok: false, reason: 'the model declined the request', steps: turns };
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      return { ok: false, reason: `the model stopped without acting: ${text.slice(0, 300)}`, steps: turns };
    }

    // Echo the assistant turn back verbatim, thinking blocks included.
    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;

    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown>;
      a.logger.log({ type: 'model.turn', index: turns, toolName: tu.name });

      try {
        const out = await handleTool(a, tu.name, input, lastObservation, () => {
          finished = true;
        });
        if (out.observation) lastObservation = out.observation;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `ERROR: ${(e as Error).message}`, is_error: true });
      }
    }

    messages.push({ role: 'user', content: results });
    a.transcript.push({ turn: turns, role: 'user', content: a.redactor.json(results) });

    if (finished) return { ok: true, steps: turns };
  }

  return { ok: false, reason: `reached the ${a.maxSteps}-turn budget without completing the goal`, steps: turns };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'observe',
    description:
      'Look at the current screen. Returns the URL, an accessibility snapshot per frame, and the list of interactive controls with a ref for each. Call this before your first action and whenever the screen may have changed.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'navigate',
    description: 'Load a URL in the top-level document. Only URLs inside the allowlist are permitted.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, why: { type: 'string', description: 'One sentence: why this step is needed.' } },
      required: ['url', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click a control, addressed by the ref from the most recent observe.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, why: { type: 'string' } },
      required: ['ref', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description:
      'Type a value into a text control. To enter a capability input or a credential, pass its placeholder exactly as given in the system prompt (for example {{inputs.memberId}}); the harness substitutes the real value and you never see it.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' }, why: { type: 'string' } },
      required: ['ref', 'value', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown, by its visible option text or value.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' }, why: { type: 'string' } },
      required: ['ref', 'value', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description: 'Read the text of a control or cell and bind it to one of the capability’s declared outputs.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        field: { type: 'string', description: 'The declared output name to bind this value to.' },
        why: { type: 'string' },
      },
      required: ['ref', 'field', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'checkpoint',
    description:
      'Record proof that the previous action reached the state you intended. provingText must be static wording that is part of the application — a screen title, a field label, a fixed message — and must NOT contain any data value from this run.',
    input_schema: {
      type: 'object',
      properties: {
        provingText: { type: 'string' },
        frame: { type: 'string', description: 'Frame name the text appears in, or omit for anywhere.' },
        description: { type: 'string' },
      },
      required: ['provingText', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Declare the goal reached. provingText follows the same rule as checkpoint: static wording only.',
    input_schema: {
      type: 'object',
      properties: { provingText: { type: 'string' }, frame: { type: 'string' }, summary: { type: 'string' } },
      required: ['provingText', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_outcome',
    description:
      'Record the detector for a business outcome you have just provoked. provingText must be the static part of the application’s message, excluding any data value.',
    input_schema: {
      type: 'object',
      properties: { provingText: { type: 'string' }, frame: { type: 'string' }, summary: { type: 'string' } },
      required: ['provingText', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description: 'Stop and hand the session to a human. Use when the application requires something you cannot supply or you cannot make progress.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

async function handleTool(
  a: PhaseArgs,
  name: string,
  input: Record<string, unknown>,
  lastObservation: Observation | null,
  markFinished: () => void,
): Promise<{ content: string; observation?: Observation }> {
  const findControl = (ref: string): ControlDescriptor => {
    const c = lastObservation?.controls.find((x) => x.ref === ref);
    if (!c) throw new Error(`unknown ref "${ref}". Call observe again — refs are only valid for the most recent observation.`);
    return c;
  };

  switch (name) {
    case 'observe': {
      const obs = await a.surface.observe();
      a.logger.log({ type: 'observation', url: obs.url, title: obs.title, controlCount: obs.controls.length, frames: obs.frames.length });
      return { content: renderObservation(obs), observation: obs };
    }

    case 'navigate': {
      const url = String(input.url);
      const decision = a.policy.checkUrl(url);
      a.logger.log({ type: 'policy.decision', effect: decision.effect, code: 'code' in decision ? decision.code : undefined, reason: 'reason' in decision ? decision.reason : undefined });
      if (decision.effect !== 'allow') return { content: `REFUSED by policy: ${'reason' in decision ? decision.reason : 'not allowed'}` };
      const r = await a.surface.perform({ type: 'navigate', url }, 20_000);
      if (!r.ok) return { content: `navigate failed: ${r.error}` };
      if (a.recordSteps) a.recorder.recordNavigate(url);
      const obs = await a.surface.observe();
      return { content: `Navigated.\n\n${renderObservation(obs)}`, observation: obs };
    }

    case 'click': {
      const c = findControl(String(input.ref));
      const label = c.name ?? c.visualLabel ?? c.fieldName ?? c.role;
      const decision = a.policy.checkAction({ type: 'click', target: { description: label, framePath: c.framePath, strategies: c.candidateStrategies } }, 'read', label);
      a.logger.log({ type: 'policy.decision', effect: decision.effect, code: 'code' in decision ? decision.code : undefined, reason: 'reason' in decision ? decision.reason : undefined });
      if (decision.effect === 'deny') return { content: `REFUSED by policy: ${decision.reason}` };
      if (decision.effect === 'require_confirmation') {
        // During discovery an irreversible control is never pressed. The step
        // can still be recorded by a human, but the recorder will not learn it
        // by doing it — a recording run must not move money.
        return {
          content:
            `REFUSED: "${label}" is classified irreversible (${decision.reason}). Discovery never performs irreversible actions. ` +
            `Reach the confirmation screen and stop there, or call give_up.`,
        };
      }
      const r = await a.surface.resolveRef(String(input.ref));
      if (!r.ok) return { content: `could not act on ${String(input.ref)}: ${r.failure.reason}` };
      const perf = await a.surface.perform({ type: 'click', target: r.target }, 15_000);
      if (!perf.ok) return { content: `click failed: ${perf.error}` };
      if (a.recordSteps) a.recorder.recordClick(c, String(input.why ?? ''));
      const obs = await a.surface.observe();
      return { content: `Clicked "${label}".\n\n${renderObservation(obs)}`, observation: obs };
    }

    case 'fill':
    case 'select': {
      const c = findControl(String(input.ref));
      const raw = String(input.value ?? '');
      const resolved = substitutePlaceholder(raw, a.inputValues, a.credentials);
      if (resolved === null) {
        return { content: `"${raw}" is not a known placeholder. Use one of: ${placeholderList(a.inputValues, a.credentials)}, or a literal value.` };
      }
      const r = await a.surface.resolveRef(String(input.ref));
      if (!r.ok) return { content: `could not act on ${String(input.ref)}: ${r.failure.reason}` };
      const perf = await a.surface.perform(
        name === 'fill' ? { type: 'fill', target: r.target, value: resolved } : { type: 'select', target: r.target, value: resolved },
        10_000,
      );
      if (!perf.ok) return { content: `${name} failed: ${perf.error}` };
      if (a.recordSteps) {
        if (name === 'fill') a.recorder.recordFill(c, resolved, String(input.why ?? ''));
        else a.recorder.recordSelect(c, resolved, String(input.why ?? ''));
      }
      const label = c.name ?? c.visualLabel ?? c.fieldName ?? c.role;
      return { content: `Entered a value into "${label}".` };
    }

    case 'read': {
      const c = findControl(String(input.ref));
      const field = String(input.field);
      const r = await a.surface.resolveRef(String(input.ref));
      if (!r.ok) return { content: `could not read ${String(input.ref)}: ${r.failure.reason}` };
      const perf = await a.surface.perform({ type: 'readText', target: r.target }, 10_000);
      if (!perf.ok) return { content: `read failed: ${perf.error}` };
      if (a.recordSteps) a.recorder.recordExtract(c, field, String(input.why ?? ''));
      a.logger.log({ type: 'extract', stepId: a.recorder.lastStepId() ?? 'n/a', field, sensitivity: 'unknown', value: perf.text ?? '' });
      // The value is echoed so the model can confirm it read the right cell.
      // It is redacted on its way to the evidence log, not here.
      return { content: `Read ${field} = ${JSON.stringify(perf.text ?? '')}` };
    }

    case 'checkpoint': {
      const text = String(input.provingText);
      const bad = a.recorder.validateProvingText(text);
      if (bad) return { content: `REJECTED: ${bad}` };
      const check = await a.surface.evaluate({ kind: 'textPresent', value: text, match: 'contains' }, 2000);
      if (!check.held) return { content: `REJECTED: ${JSON.stringify(text)} is not present on the current screen.` };
      if (a.recordSteps) a.recorder.attachCheckpoint(text, input.frame ? [String(input.frame)] : undefined);
      return { content: `Checkpoint recorded.` };
    }

    case 'finish': {
      if (a.finishToolName !== 'finish') return { content: 'This phase expects record_outcome, not finish.' };
      const text = String(input.provingText);
      const bad = a.recorder.validateProvingText(text);
      if (bad) return { content: `REJECTED: ${bad}` };
      const check = await a.surface.evaluate({ kind: 'textPresent', value: text, match: 'contains' }, 2000);
      if (!check.held) return { content: `REJECTED: ${JSON.stringify(text)} is not present on the current screen.` };
      a.recorder.setSuccess(text, input.frame ? [String(input.frame)] : undefined);
      markFinished();
      return { content: 'Goal recorded as reached.' };
    }

    case 'record_outcome': {
      if (a.finishToolName !== 'record_outcome' || !a.outcomeCode) return { content: 'This phase expects finish, not record_outcome.' };
      const text = String(input.provingText);
      const bad = a.recorder.validateProvingText(text);
      if (bad) return { content: `REJECTED: ${bad}` };
      const check = await a.surface.evaluate({ kind: 'textPresent', value: text, match: 'contains' }, 2000);
      if (!check.held) return { content: `REJECTED: ${JSON.stringify(text)} is not present on the current screen.` };
      a.recorder.recordOutcome(a.outcomeCode, text, input.frame ? [String(input.frame)] : undefined);
      a.logger.log({ type: 'outcome.detected', code: a.outcomeCode, message: text });
      markFinished();
      return { content: `Detector for ${a.outcomeCode} recorded.` };
    }

    case 'give_up':
      markFinished();
      throw new Error(`agent gave up: ${String(input.reason)}`);

    default:
      return { content: `unknown tool ${name}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Prompts and rendering                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Observations are rendered as text rather than JSON: the accessibility
 * snapshot is already a readable tree, and a control table is easier for the
 * model to index into than nested objects. Raw HTML is never shown — it is
 * both enormous and, on a legacy surface, actively misleading.
 */
function renderObservation(obs: Observation): string {
  const frames = obs.frames
    .map((f) => {
      const path = f.framePath.join('/') || '<top>';
      return `--- frame ${path} · ${f.title} · ${f.url}\n${f.ariaSnapshot || '(no accessibility snapshot)'}`;
    })
    .join('\n\n');

  const row = (c: (typeof obs.controls)[number]) =>
    [
      `${c.ref}`.padEnd(5),
      c.role.padEnd(9),
      c.name ? `name=${JSON.stringify(c.name)}` : '',
      c.visualLabel ? `label=${JSON.stringify(c.visualLabel)}` : '',
      c.fieldName ? `field=${c.fieldName}` : '',
      c.kind === 'value' && c.value ? `text=${JSON.stringify(c.value.slice(0, 60))}` : '',
      c.enabled ? '' : 'DISABLED',
      `frame=${c.framePath.join('/') || '<top>'}`,
    ]
      .filter(Boolean)
      .join('  ');

  const interactive = obs.controls.filter((c) => c.kind === 'interactive').map(row).join('\n');
  const values = obs.controls.filter((c) => c.kind === 'value').map(row).join('\n');

  return (
    `URL: ${obs.url}\nHTTP: ${obs.httpStatus ?? 'n/a'}\n\n${frames}\n\n` +
    `--- interactive controls (click / fill / select these by ref)\n${interactive || '(none)'}\n\n` +
    `--- readable value cells (use read on these by ref)\n${values || '(none)'}`
  );
}

function entryPath(entry: string): string {
  return entry.replace('{{env.baseUrl}}', '');
}

function placeholderList(inputs: Record<string, string>, credentials: Record<string, string>): string {
  return [...Object.keys(inputs).map((k) => `{{inputs.${k}}}`), ...Object.keys(credentials).map((k) => `{{env.secret_${k}}}`)].join(', ') || '(none)';
}

/**
 * Placeholder substitution is how credentials are kept out of the model's
 * context entirely. The model asks for `{{env.secret_OPERATOR_PASSWORD}}`; the
 * harness types the real value. The model never sees it, so it cannot be
 * echoed into a transcript, a checkpoint or a recorded step.
 */
function substitutePlaceholder(raw: string, inputs: Record<string, string>, credentials: Record<string, string>): string | null {
  const m = /^\{\{\s*(inputs|env)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(raw.trim());
  if (!m) return raw; // literal value; allowed
  const [, scope, name] = m;
  if (scope === 'inputs') return inputs[name as string] ?? null;
  const key = (name as string).replace(/^secret_/, '');
  return credentials[key] ?? null;
}

function happyPathSystemPrompt(spec: CapabilitySpec, inputs: Record<string, string>, credentials: Record<string, string>): string {
  return `You are recording a reusable automation for a back-office banking application by driving it yourself, once.

What you produce is not a transcript — it is a capability that will be replayed thousands of times WITHOUT you. Every choice you make is a choice the replay engine inherits.

## The contract (already fixed; do not redesign it)
Capability: ${spec.id}@${spec.version} — ${spec.description}
Inputs available: ${spec.inputs.map((i) => `${i.name}:${i.type} (${i.description})`).join('; ') || '(none)'}
Outputs to extract: ${spec.outputs.map((o) => `${o.name}:${o.type} (${o.description})`).join('; ') || '(none)'}
Placeholders you may pass to fill/select: ${placeholderList(inputs, credentials)}

## How to work
1. Call observe first, and again after anything that could change the screen. Refs expire with each observation.
2. Address controls only by ref. Never invent a selector.
3. To enter an input or a credential, pass the placeholder, not a literal. You will never be shown a credential's value.
4. After each action that changes the screen, call checkpoint with wording that PROVES you arrived: a screen title, a field label, a fixed message. Never use a value from this run — a checkpoint containing "123456" would only ever hold for this one member.
5. Use read to bind each declared output to the control that displays it. Prefer the specific cell over a whole table.
6. When the goal is met, call finish.

## Constraints
- This application is a frameset. Controls carry a frame; act on the right one.
- Some controls have no accessible name. The recovered visual label in the control list is what a human operator would call them.
- You must not perform irreversible actions. If one is required, stop at the confirmation screen.
- If you cannot make progress, call give_up rather than guessing.

Be economical: the shortest correct path makes the best capability.`;
}

function outcomeSystemPrompt(
  spec: CapabilitySpec,
  code: string,
  description: string,
  probe: Record<string, string>,
  credentials: Record<string, string>,
): string {
  return `You are teaching a recorded automation how to recognise one specific NON-FAILURE answer from a back-office banking application.

The capability ${spec.id} already knows the happy path. Your job now is to make the application produce the outcome ${code} ("${description}") and record the wording that identifies it, so that at replay time this answer is reported to the caller as data rather than as a crash.

Placeholders you may pass to fill/select: ${placeholderList(probe, credentials)}

Steps: observe, walk the same route as the normal flow, submit the probe values, then call record_outcome with the STATIC part of the application's message.

The proving text must not contain any value from the probe inputs. "No member record found for 000000." is wrong; "No member record found" is right.

Do not call checkpoint, read or finish in this phase.`;
}

export { digest };
