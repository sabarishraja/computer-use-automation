import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader. A dependency for six lines of parsing is not worth it. */
export function loadEnv(file = '.env'): void {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

export type Args = { flags: Record<string, string | true>; params: Record<string, string>; positional: string[] };

/** `--key value`, `--flag`, and repeatable `--param name=value`. */
export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const params: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'param') {
      const kv = String(next ?? '');
      const j = kv.indexOf('=');
      if (j > 0) params[kv.slice(0, j)] = kv.slice(j + 1);
      i++;
      continue;
    }
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { flags, params, positional };
}

export function flagStr(args: Args, name: string, fallback: string): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

/** Credentials for the target app, read from the environment only. */
export function credentialsFromEnv(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[`CUA_SECRET_${k}`];
    if (v) out[k] = v;
  }
  return out;
}

export async function armChaos(baseUrl: string, tenant: string, mode: string): Promise<void> {
  await fetch(`${baseUrl}/t/${tenant}/__chaos?mode=${encodeURIComponent(mode)}`).catch(() => {});
}

export async function isUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Start the bundled target app unless one is already listening. Makes every
 * demo a single command, which matters more than architectural purity for a
 * thing whose job is to be run by a reviewer once.
 */
export async function ensureTargetApp(baseUrl: string): Promise<{ close: () => Promise<void> }> {
  if (await isUp(baseUrl + '/')) return { close: async () => {} };
  const { start } = await import('../../target-app/server.js');
  const port = Number(new URL(baseUrl).port || 4173);
  const s = await start(port);
  return { close: s.close };
}

export const EVIDENCE_ROOT = resolve(process.cwd(), 'evidence');
export const CAPABILITY_DIR = resolve(process.cwd(), 'capabilities');
