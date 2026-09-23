import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { originPrefixMatches } from '../src/policy/origins.js';

/**
 * ============================================================================
 * Structural guarantees
 * ============================================================================
 *
 * The claims these cover were previously true by construction and by nothing
 * else — README said "if it works with the key unset", which is a smell test a
 * reviewer has to perform by hand. A claim the build cannot break is worth more
 * than a claim a person has to re-verify.
 */

const SRC = resolve(__dirname, '..', 'src');

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)) out.push(m[1] as string);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

/** Everything `entry` can reach, following relative imports only. */
function reachableFrom(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);

    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      // Source is authored with .js specifiers for ESM; resolve back to .ts.
      const abs = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
      queue.push(abs);
    }
  }
  return { files, packages };
}

describe('structure — no model in the replay path', () => {
  const { files, packages } = reachableFrom(join(SRC, 'replay', 'engine.ts'));

  it('the replay engine cannot reach the Anthropic SDK', () => {
    expect([...packages].filter((p) => p.includes('anthropic'))).toEqual([]);
  });

  it('the replay engine cannot reach the discovery agent', () => {
    const agentFiles = [...files].filter((f) => f.includes(`${sep}agent${sep}`));
    expect(agentFiles).toEqual([]);
  });

  it('the replay CLI cannot reach the Anthropic SDK either', () => {
    const { packages: cliPackages } = reachableFrom(join(SRC, 'cli', 'replay.ts'));
    expect([...cliPackages].filter((p) => p.includes('anthropic'))).toEqual([]);
  });
});

describe('structure — the graph walker actually detects what it claims to', () => {
  // A structural test that cannot fail is worse than no test. Discovery DOES
  // reach both, so these assertions prove the walker sees them.
  const { files, packages } = reachableFrom(join(SRC, 'cli', 'discover.ts'));

  it('sees the Anthropic SDK from the discovery CLI', () => {
    expect([...packages].some((p) => p.includes('anthropic'))).toBe(true);
  });

  it('sees the agent module from the discovery CLI', () => {
    expect([...files].some((f) => f.includes(`${sep}agent${sep}`))).toBe(true);
  });
});

describe('structure — the policy layer does not depend on a driver', () => {
  it('nothing under src/policy imports the Playwright surface', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });

    for (const file of walk(join(SRC, 'policy'))) {
      expect(importsOf(file).filter((i) => i.includes('web-playwright'))).toEqual([]);
    }
  });
});

describe('origin allowlist matches on a path boundary', () => {
  const allowed = 'http://127.0.0.1:4173/t/summit';

  it('permits the allowed prefix and paths under it', () => {
    expect(originPrefixMatches(new URL('http://127.0.0.1:4173/t/summit'), allowed)).toBe(true);
    expect(originPrefixMatches(new URL('http://127.0.0.1:4173/t/summit/'), allowed)).toBe(true);
    expect(originPrefixMatches(new URL('http://127.0.0.1:4173/t/summit/member/123456'), allowed)).toBe(true);
  });

  it('refuses a sibling path that merely shares the prefix', () => {
    // Raw startsWith let this through — a neighbouring institution's records.
    expect(originPrefixMatches(new URL('http://127.0.0.1:4173/t/summit-archive/x'), allowed)).toBe(false);
    expect(originPrefixMatches(new URL('http://127.0.0.1:4173/t/harbor/'), allowed)).toBe(false);
  });

  it('refuses a domain that merely starts with an allowed bare host', () => {
    expect(originPrefixMatches(new URL('https://bank.example.evil.com/'), 'https://bank.example')).toBe(false);
    expect(originPrefixMatches(new URL('https://bank.example/x'), 'https://bank.example')).toBe(true);
  });

  it('refuses a different port or scheme on the same host', () => {
    expect(originPrefixMatches(new URL('http://127.0.0.1:9999/t/summit/'), allowed)).toBe(false);
    expect(originPrefixMatches(new URL('https://127.0.0.1:4173/t/summit/'), allowed)).toBe(false);
  });
});
