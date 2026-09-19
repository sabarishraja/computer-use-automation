import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapabilityStore } from '../artifact/store.js';
import { TenantOverlay } from '../artifact/schema.js';
import { resolveForTenant } from '../artifact/overlay.js';
import { CAPABILITY_DIR, flagStr, loadEnv, parseArgs } from './common.js';

/**
 * Attach a tenant overlay to a recorded capability.
 *
 *   npm run overlay -- --capability memberlink.lookup-member-balance --overlay capabilities/overlays/harbor.json
 *
 * Deliberately a separate step from recording: onboarding an institution is an
 * operational act with its own review, not a side effect of someone re-running
 * discovery.
 */
async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const ref = flagStr(args, 'capability', '');
  const file = flagStr(args, 'overlay', '');
  if (!ref || !file) {
    console.error('usage: npm run overlay -- --capability <id[@version]> --overlay <path/to/overlay.json>');
    process.exit(2);
  }

  const store = new CapabilityStore(CAPABILITY_DIR);
  const cap = store.load(ref);
  const overlay = TenantOverlay.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));

  const others = cap.tenantOverlays.filter((o) => o.tenantId !== overlay.tenantId);
  const updated = { ...cap, tenantOverlays: [...others, overlay] };
  const { path } = store.save(updated);

  // Resolve it immediately: an overlay that cannot produce a valid capability
  // should fail here, not on the first call from a tenant's live agent.
  const resolved = resolveForTenant(updated, overlay.tenantId);
  console.log(`[overlay] attached ${overlay.tenantId} to ${cap.id}@${cap.version}`);
  console.log(`[overlay] entry     ${resolved.surface.entry}`);
  console.log(`[overlay] terms     ${Object.keys(overlay.terms).length} substitutions`);
  console.log(`[overlay] origins   ${resolved.policy.allowedOrigins.join(', ')}`);
  console.log(`[overlay] saved     ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
