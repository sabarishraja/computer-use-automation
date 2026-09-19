import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapabilitySpec } from '../agent/spec.js';
import { discover, DEFAULT_MODEL } from '../agent/loop.js';
import { CapabilityStore } from '../artifact/store.js';
import { validateCapability } from '../artifact/schema.js';
import { EscalationBroker } from '../escalation/broker.js';
import { OperatorConsole } from '../escalation/operator-console.js';
import { Redactor } from '../policy/redaction.js';
import { CAPABILITY_DIR, EVIDENCE_ROOT, credentialsFromEnv, ensureTargetApp, flagBool, flagStr, loadEnv, parseArgs } from './common.js';

/**
 * Discovery CLI.
 *
 *   npm run discover -- --spec capabilities/specs/memberlink.lookup-member-balance.json
 *
 * Requires ANTHROPIC_API_KEY. This is the one path in the system that talks to
 * a model; everything downstream runs without one.
 */
async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const specPath = flagStr(args, 'spec', '');
  if (!specPath) {
    console.error('usage: npm run discover -- --spec <path/to/spec.json> [--headed] [--base-url URL] [--model ID]');
    process.exit(2);
  }

  const spec = CapabilitySpec.parse(JSON.parse(readFileSync(resolve(specPath), 'utf8')));
  const baseUrl = flagStr(args, 'base-url', process.env.TARGET_BASE_URL ?? 'http://127.0.0.1:4173');
  const model = flagStr(args, 'model', process.env.CUA_MODEL ?? DEFAULT_MODEL);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Discovery is the only step that needs it; replay does not.');
    process.exit(2);
  }

  const target = await ensureTargetApp(baseUrl);

  const broker = new EscalationBroker(EVIDENCE_ROOT, new Redactor('discovery'));
  const consolePort = Number(process.env.OPERATOR_CONSOLE_PORT ?? 4180);
  const operatorConsole = new OperatorConsole(broker, consolePort);
  await operatorConsole.start();

  console.log(`[discover] spec      ${spec.id}@${spec.version}`);
  console.log(`[discover] model     ${model}`);
  console.log(`[discover] target    ${baseUrl}`);
  console.log(`[discover] operator  ${operatorConsole.baseUrl}`);
  console.log(`[discover] goal      ${spec.goal}`);

  const result = await discover({
    spec,
    baseUrl,
    model,
    evidenceRoot: EVIDENCE_ROOT,
    headless: !flagBool(args, 'headed'),
    credentials: credentialsFromEnv(spec.credentials.map((c) => c.envKey)),
    escalation: { broker, consoleBaseUrl: operatorConsole.baseUrl, timeoutMs: 10 * 60_000 },
  });

  await operatorConsole.stop();
  await target.close();

  if (result.status === 'failed') {
    console.error(`\n[discover] FAILED: ${result.reason}`);
    console.error(`[discover] evidence: ${result.evidenceDir}`);
    process.exit(1);
  }

  const store = new CapabilityStore(CAPABILITY_DIR);
  const { path, issues } = store.save(result.capability);

  console.log(`\n[discover] recorded ${result.capability.steps.length} steps`);
  console.log(`[discover] outcomes ${result.capability.outcomes.map((o) => o.code).join(', ') || '(none observed)'}`);
  console.log(`[discover] artifact ${path}`);
  console.log(`[discover] evidence ${result.evidenceDir}`);
  for (const i of issues) console.log(`[discover] ${i.level}: ${i.message}`);

  const warnings = validateCapability(result.capability).filter((i) => i.level === 'warning');
  console.log(
    `\n[discover] state is "draft". Review the artifact, then set "state": "approved" to allow unattended replay` +
      (warnings.length ? ` (${warnings.length} warning(s) above deserve a look first).` : '.'),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
