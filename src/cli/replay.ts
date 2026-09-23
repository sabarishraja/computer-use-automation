import { CapabilityStore } from '../artifact/store.js';
import { replay } from '../replay/engine.js';
import { EscalationBroker } from '../escalation/broker.js';
import { OperatorConsole } from '../escalation/operator-console.js';
import { runAutoOperator, type OperatorPlaybook } from '../escalation/auto-operator.js';
import { Redactor } from '../policy/redaction.js';
import { CAPABILITY_DIR, EVIDENCE_ROOT, armChaos, credentialsFromEnv, ensureTargetApp, flagBool, flagStr, loadEnv, parseArgs } from './common.js';

/**
 * Replay CLI — the production execution path.
 *
 *   npm run replay -- --capability memberlink.lookup-member-balance --param memberId=123456
 *
 * Never reads ANTHROPIC_API_KEY. If this command works with the key unset,
 * replay is genuinely model-free, which is the property the whole design is
 * for. `--chaos` arms a runtime fault in the target app first, so the error
 * paths are demonstrable rather than described.
 */

/** The scripted supervisor used by `--operator auto`. */
function playbooks(): OperatorPlaybook[] {
  const code = process.env.CUA_SECRET_OVERRIDE_CODE ?? '4417';
  return [
    {
      when: 'override code',
      type: { 'Override Code': code },
      click: ['Authorize'],
      disposition: 'resume_step_done',
      notes: 'Supervisor override authorised for a deposit above the branch limit.',
    },
    {
      when: 'operator id',
      type: { 'Operator ID': process.env.CUA_SECRET_OPERATOR_ID ?? 'OPR001', Password: process.env.CUA_SECRET_OPERATOR_PASSWORD ?? '' },
      click: ['Sign On'],
      disposition: 'resume',
      notes: 'Signed the session back on after expiry.',
    },
  ];
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const ref = flagStr(args, 'capability', '');
  if (!ref) {
    console.error(
      'usage: npm run replay -- --capability <id[@version]> --param k=v [--tenant summit] [--chaos slow|interstitial|expire|apperror]\n' +
        '                       [--operator auto|console|none] [--headed] [--allow-draft]',
    );
    process.exit(2);
  }

  const baseUrl = flagStr(args, 'base-url', process.env.TARGET_BASE_URL ?? 'http://127.0.0.1:4173');
  const tenant = args.flags['tenant'] ? flagStr(args, 'tenant', '') : undefined;
  const chaos = flagStr(args, 'chaos', 'none');
  const operatorMode = flagStr(args, 'operator', 'auto');

  // Unvalidated, a typo was worse than useless: `--chaos expired` printed
  // "armed runtime fault", armed nothing, and the clean pass that followed read
  // as "the fault was survived". `--operator bogus` quietly became console mode
  // and hung the run until the ticket timeout.
  const CHAOS_MODES = ['none', 'slow', 'interstitial', 'expire', 'apperror'];
  if (!CHAOS_MODES.includes(chaos)) {
    console.error(`unknown --chaos "${chaos}". Expected one of: ${CHAOS_MODES.join(', ')}`);
    process.exit(2);
  }
  const OPERATOR_MODES = ['auto', 'console', 'none'];
  if (!OPERATOR_MODES.includes(operatorMode)) {
    console.error(`unknown --operator "${operatorMode}". Expected one of: ${OPERATOR_MODES.join(', ')}`);
    process.exit(2);
  }

  const store = new CapabilityStore(CAPABILITY_DIR);
  let capability;
  try {
    capability = store.load(ref);
  } catch (e) {
    // A caller shelling out parses stdout. A raw stack trace on stderr with an
    // empty stdout gives it nothing to parse, so loading failures speak the
    // same result contract as everything else.
    console.log(
      JSON.stringify(
        { status: 'failure', error: { category: 'configuration', retryable: false, message: (e as Error).message } },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const target = await ensureTargetApp(baseUrl);
  if (chaos !== 'none') {
    await armChaos(baseUrl, tenant ?? 'summit', chaos);
    console.log(`[replay] armed runtime fault: ${chaos}`);
  }

  const broker = new EscalationBroker(EVIDENCE_ROOT, new Redactor('replay'));
  const consolePort = Number(process.env.OPERATOR_CONSOLE_PORT ?? 4180);
  const operatorConsole = new OperatorConsole(broker, consolePort);
  const escalationEnabled = operatorMode !== 'none';
  if (escalationEnabled) await operatorConsole.start();

  console.log(`[replay] capability ${capability.id}@${capability.version} (${capability.state})`);
  console.log(`[replay] tenant     ${tenant ?? '(base)'}`);
  console.log(`[replay] inputs     ${JSON.stringify(args.params)}`);
  if (escalationEnabled) console.log(`[replay] operator   ${operatorConsole.baseUrl} (${operatorMode})`);

  const credentialKeys = ['OPERATOR_ID', 'OPERATOR_PASSWORD'];
  const env: Record<string, string> = { baseUrl };
  for (const [k, v] of Object.entries(credentialsFromEnv(credentialKeys))) env[`secret_${k}`] = v;

  // The scripted operator races the run: it waits for a ticket to appear. Once
  // the run is over no ticket can arrive, so the race is cancelled rather than
  // left to expire against its own timeout.
  const operatorDone = new AbortController();
  const operatorTask =
    operatorMode === 'auto' && escalationEnabled
      ? runAutoOperator({
          consoleBaseUrl: operatorConsole.baseUrl,
          playbooks: playbooks(),
          timeoutMs: 120_000,
          signal: operatorDone.signal,
          log: (m) => console.log(m),
        }).catch((e) => {
          console.error('[operator] ' + (e as Error).message);
          return { handled: 0 };
        })
      : Promise.resolve({ handled: 0 });

  const result = await replay({
    capability,
    inputs: args.params,
    tenantId: tenant,
    env,
    headless: !flagBool(args, 'headed'),
    evidenceRoot: EVIDENCE_ROOT,
    allowDraft: flagBool(args, 'allow-draft'),
    escalation: escalationEnabled
      ? { broker, consoleBaseUrl: operatorConsole.baseUrl, timeoutMs: operatorMode === 'console' ? 15 * 60_000 : 90_000 }
      : undefined,
  });

  operatorDone.abort();
  await operatorTask;
  if (escalationEnabled) await operatorConsole.stop();
  await target.close();

  console.log('\n' + '─'.repeat(72));
  console.log(JSON.stringify(result, null, 2));
  console.log('─'.repeat(72));
  console.log(`[replay] evidence ${result.evidenceDir}`);

  // Exit codes are part of the contract for a caller shelling out to this:
  // 0 success, 3 a legitimate business outcome, 1 a failure.
  if (result.status === 'success') process.exit(0);
  if (result.status === 'business_outcome') process.exit(3);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
