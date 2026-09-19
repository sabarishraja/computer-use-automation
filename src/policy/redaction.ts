import { createHash } from 'node:crypto';
import type { Sensitivity } from '../artifact/schema.js';

/**
 * ============================================================================
 * Redaction
 * ============================================================================
 *
 * Two mechanisms, because either one alone is insufficient.
 *
 *  1. DECLARED redaction. Every input and output carries a `sensitivity` in the
 *     artifact, so the exact string values flowing through a run are registered
 *     with the redactor and scrubbed wherever they appear — in a log line, in a
 *     page-text excerpt, in an error message, in an escalation payload. This is
 *     the reliable half: it does not depend on guessing what data looks like.
 *
 *  2. PATTERN redaction. A backstop for values that were never declared,
 *     because they arrived from the page rather than from the caller: an SSN in
 *     an error banner, a card number in a table cell. Patterns are lossy and
 *     will both over- and under-match; they exist so that an undeclared leak is
 *     unlikely rather than impossible.
 *
 * The honest limit, stated here and in REPORT.md: redaction cannot make an
 * arbitrary screenshot safe. Screenshots of pages showing account data are
 * therefore captured only on failure, stored outside the artifact, and treated
 * as regulated data with the same retention as the underlying system.
 */

export type RedactionClass = Sensitivity;

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card', re: /\b(?:\d[ -]*?){13,19}\b/g },
  { label: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { label: 'apikey', re: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{12,}\b/gi },
  { label: 'routing', re: /\baba[:\s#]*\d{9}\b/gi },
];

export class Redactor {
  /** value -> class. Longest-first so overlapping values redact correctly. */
  private registered: Array<{ value: string; cls: RedactionClass }> = [];
  private salt: string;

  constructor(salt = 'cua') {
    this.salt = salt;
  }

  /**
   * Register a concrete value to be scrubbed. Short values are skipped: a
   * one- or two-character input would turn every log line into mush and tells
   * an attacker nothing anyway.
   */
  register(value: unknown, cls: RedactionClass): void {
    if (cls === 'public') return;
    const s = String(value ?? '');
    if (s.length < 3) return;
    if (this.registered.some((r) => r.value === s && r.cls === cls)) return;
    this.registered.push({ value: s, cls });
    this.registered.sort((a, b) => b.value.length - a.value.length);
  }

  /** Stable per-run pseudonym: lets you correlate log lines without the value. */
  token(value: string, cls: RedactionClass): string {
    if (cls === 'identifier') {
      const h = createHash('sha256').update(this.salt + ':' + value).digest('hex').slice(0, 10);
      return `[id:${h}]`;
    }
    return `[redacted:${cls}]`;
  }

  text(input: string): string {
    let out = input;
    for (const { value, cls } of this.registered) {
      if (!value) continue;
      out = out.split(value).join(this.token(value, cls));
    }
    for (const { label, re } of PATTERNS) {
      out = out.replace(re, (m) => (looksLikeNoise(m, label) ? m : `[redacted:${label}]`));
    }
    return out;
  }

  /** Deep-redacts an object for persistence. Keys are never redacted, values are. */
  json<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = this.walk(val);
      return out;
    }
    return v;
  }

  /**
   * Split outputs into what the caller receives and what may be written to
   * evidence. Financial and PII values are legitimate results — the agent asked
   * for the balance — but they are not artefacts we are entitled to keep.
   */
  partitionOutputs(
    values: Record<string, unknown>,
    fields: Array<{ name: string; sensitivity: Sensitivity }>,
    neverPersist: string[],
  ): { forCaller: Record<string, unknown>; forEvidence: Record<string, unknown> } {
    const byName = new Map(fields.map((f) => [f.name, f.sensitivity]));
    const forCaller: Record<string, unknown> = {};
    const forEvidence: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const cls = byName.get(k) ?? 'public';
      if (cls === 'secret') continue; // never returned at all
      forCaller[k] = v;
      if (neverPersist.includes(k) || cls === 'financial' || cls === 'pii') {
        forEvidence[k] = this.token(String(v), cls);
      } else if (cls === 'identifier') {
        forEvidence[k] = this.token(String(v), cls);
      } else {
        forEvidence[k] = v;
      }
    }
    return { forCaller, forEvidence };
  }
}

/**
 * The card pattern is greedy enough to swallow things like "2024 3 15" or a
 * money column. A Luhn check removes most of that noise; it is a heuristic, and
 * the declared-value path above is what we actually rely on.
 */
function looksLikeNoise(m: string, label: string): boolean {
  if (label !== 'card') return false;
  const digits = m.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return true;
  return !luhn(digits);
}

function luhn(d: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
