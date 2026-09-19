import { CapabilityStore } from '../artifact/store.js';
import { capabilityRisk, type Capability, type ParamType } from '../artifact/schema.js';
import { CAPABILITY_DIR, flagBool, flagStr, loadEnv, parseArgs } from './common.js';

/**
 * ============================================================================
 * Agent-facing capability catalog  (stretch goal: the invocable surface)
 * ============================================================================
 *
 * Saved artifacts, projected as a list of callable tools. This is the shape the
 * agent-facing product consumes: it discovers what it can do by name, sees the
 * typed arguments, sees what it gets back, sees which non-failure answers to
 * expect, and sees the risk class so it knows whether a human is in the path.
 *
 * `--tools` emits a tool array in the Anthropic Messages API shape, which is
 * the point of the exercise — the contract in the artifact is already
 * everything a tool definition needs, so the projection is mechanical. That the
 * projection is mechanical is the evidence that the schema was designed as a
 * contract rather than as a step list.
 */

function jsonType(t: ParamType): { type: string; format?: string } {
  switch (t) {
    case 'number':
    case 'money':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    default:
      return { type: 'string' };
  }
}

export function toToolDefinition(cap: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of cap.inputs) {
    properties[p.name] = {
      ...jsonType(p.type),
      description: p.description,
      ...(p.pattern ? { pattern: p.pattern } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required && p.default === undefined) required.push(p.name);
  }

  const outcomes = cap.outcomes.map((o) => `${o.code} — ${o.description}`).join('; ');
  const returns = cap.outputs.map((o) => `${o.name}:${o.type} (${o.description})`).join('; ') || 'nothing';

  return {
    name: cap.id.replace(/[.-]/g, '_'),
    description:
      `${cap.description}\n\n` +
      `Returns on success: ${returns}.\n` +
      (outcomes ? `May instead return one of these legitimate business outcomes: ${outcomes}.\n` : '') +
      `Risk class: ${capabilityRisk(cap)}. State: ${cap.state}.`,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const store = new CapabilityStore(CAPABILITY_DIR);
  const all = store.list().map((x) => x.cap);
  const visible = flagBool(args, 'all') ? all : all.filter((c) => c.state !== 'deprecated');

  if (flagBool(args, 'tools')) {
    console.log(JSON.stringify(visible.map(toToolDefinition), null, 2));
    return;
  }

  const invoke = flagStr(args, 'invoke', '');
  if (invoke) {
    // Invocation deliberately goes through the same CLI a human would use, so
    // there is exactly one execution path into replay.
    const { spawnSync } = await import('node:child_process');
    const params = Object.entries(args.params).flatMap(([k, v]) => ['--param', `${k}=${v}`]);
    const extra: string[] = [];
    for (const key of ['tenant', 'chaos', 'operator'] as const) {
      if (args.flags[key]) extra.push(`--${key}`, String(args.flags[key]));
    }
    if (flagBool(args, 'allow-draft')) extra.push('--allow-draft');
    const r = spawnSync('npx', ['tsx', 'src/cli/replay.ts', '--capability', invoke, ...params, ...extra], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    process.exit(r.status ?? 1);
  }

  if (visible.length === 0) {
    console.log('No capabilities recorded yet. Run: npm run discover -- --spec capabilities/specs/<spec>.json');
    return;
  }

  for (const cap of visible) {
    console.log(`\n${cap.id}@${cap.version}  [${cap.state}]  risk=${capabilityRisk(cap)}`);
    console.log(`  ${cap.name}`);
    console.log(`  app       ${cap.surface.application.vendor}/${cap.surface.application.product} ${cap.surface.application.versionRange}`);
    console.log(`  inputs    ${cap.inputs.map((i) => `${i.name}:${i.type}${i.required ? '' : '?'}`).join(', ') || '(none)'}`);
    console.log(`  outputs   ${cap.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}`);
    console.log(`  outcomes  ${cap.outcomes.map((o) => o.code).join(', ') || '(none)'}`);
    console.log(`  tenants   ${cap.tenantOverlays.map((t) => t.tenantId).join(', ') || '(base only)'}`);
    console.log(`  steps     ${cap.steps.length}`);
  }
  console.log('\nInvoke one:  npm run catalog -- --invoke <id> --param k=v');
  console.log('Tool schema: npm run catalog -- --tools');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
