import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Capability, validateCapability, type ValidationIssue } from './schema.js';

/**
 * Capabilities are plain JSON files on disk, one per capability, named
 * `<id>@<version>.json`.
 *
 * A database was the obvious alternative and was rejected: the artifact's whole
 * purpose is to be *reviewable*, and a file in git gets code review, diffs,
 * blame and rollback for free. Version is in the filename rather than a column
 * so two versions coexist and an in-flight caller pinned to 1.0.0 is unaffected
 * by 1.1.0 landing.
 */
export class CapabilityStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private path(id: string, version: string): string {
    return join(this.dir, `${id}@${version}.json`);
  }

  save(cap: Capability): { path: string; issues: ValidationIssue[] } {
    const parsed = Capability.parse(cap);
    const issues = validateCapability(parsed);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) {
      throw new Error('refusing to save an invalid capability:\n' + errors.map((e) => `  - ${e.message}`).join('\n'));
    }
    const p = this.path(parsed.id, parsed.version);
    writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    return { path: p, issues };
  }

  load(ref: string): Capability {
    // ref is "<id>@<version>", "<id>" (latest), or a path to a json file.
    const asPath = resolve(ref);
    if (ref.endsWith('.json') && existsSync(asPath)) return this.parseFile(asPath);

    const [id, version] = ref.includes('@') ? ref.split('@') : [ref, undefined];
    const candidates = this.list().filter((c) => c.id === id);
    if (candidates.length === 0) throw new Error(`no capability "${id}" in ${this.dir}`);
    const picked = version
      ? candidates.find((c) => c.version === version)
      : candidates.sort((a, b) => cmpSemver(b.version, a.version))[0];
    if (!picked) throw new Error(`capability "${id}" has no version ${version}`);
    return this.parseFile(picked.path);
  }

  private parseFile(p: string): Capability {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
    const cap = Capability.parse(raw);
    // Re-validate on load: an artifact is a reviewable file humans edit, and a
    // hand edit that breaks an invariant should fail loudly here, not midway
    // through a run against a live banking screen.
    const errors = validateCapability(cap).filter((i) => i.level === 'error');
    if (errors.length > 0) {
      throw new Error(`capability at ${p} is invalid:\n` + errors.map((e) => `  - ${e.message}`).join('\n'));
    }
    return cap;
  }

  list(): Array<{ id: string; version: string; path: string; cap: Capability }> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = join(this.dir, f);
        const cap = Capability.parse(JSON.parse(readFileSync(p, 'utf8')));
        return { id: cap.id, version: cap.version, path: p, cap };
      });
  }
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
