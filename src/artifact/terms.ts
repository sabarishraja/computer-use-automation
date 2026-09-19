import type { Condition, Locator, LocatorStrategy } from './schema.js';

/**
 * ============================================================================
 * Tenant vocabulary
 * ============================================================================
 *
 * The single most common way two institutions running the same vendor product
 * diverge is not structure — it is words. Summit calls them Members and the
 * button says Search; Harbor calls them Customers and the button says Find;
 * the balance column is "Current Balance" in one and "Available Balance" in
 * the other. The screens, the flow and the field names are identical.
 *
 * A term map is therefore the highest-leverage thing a tenant overlay can
 * carry. Six lines of vocabulary re-point every accessible name, every
 * near-text anchor and every checkpoint in a capability, without touching a
 * step. The alternative — per-tenant locator overrides for each affected step —
 * is what turns one artifact into three hundred forks.
 *
 * Substitution is applied longest-phrase-first over non-overlapping regions,
 * so "Member Search" maps to "Customer Search" rather than being mangled into
 * "Customer Find" by a later, shorter rule.
 *
 * The substituted form is always ADDED, never substituted in place: locators
 * get the tenant variant prepended and keep the base strategies as fallback,
 * and conditions become `any[tenant, base]`. A tenant whose vocabulary map is
 * wrong degrades to the base behaviour instead of breaking.
 */
export type TermMap = Record<string, string>;

export function substituteTerms(text: string, terms: TermMap): string {
  const entries = Object.entries(terms).sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) return text;

  let out = '';
  let i = 0;
  outer: while (i < text.length) {
    for (const [from, to] of entries) {
      if (from.length > 0 && text.startsWith(from, i)) {
        out += to;
        i += from.length;
        continue outer;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

export function substituteStrategy(s: LocatorStrategy, terms: TermMap): LocatorStrategy | null {
  const sub = (v: string) => substituteTerms(v, terms);
  switch (s.kind) {
    case 'role': {
      if (!s.name) return null;
      const name = sub(s.name);
      return name === s.name ? null : { ...s, name };
    }
    case 'label': {
      const text = sub(s.text);
      return text === s.text ? null : { ...s, text };
    }
    case 'text': {
      const value = sub(s.value);
      return value === s.value ? null : { ...s, value };
    }
    case 'nearText': {
      const anchor = sub(s.anchor);
      return anchor === s.anchor ? null : { ...s, anchor };
    }
    case 'tableCell': {
      const rowContains = sub(s.rowContains);
      const column = typeof s.column === 'string' ? sub(s.column) : s.column;
      return rowContains === s.rowContains && column === s.column ? null : { ...s, rowContains, column };
    }
    default:
      // fieldName, css and xpath are structural, not linguistic. A tenant that
      // renamed a form field has changed more than its vocabulary and needs a
      // real locator override.
      return null;
  }
}

/** Prepend tenant-vocabulary variants, keeping the base strategies as fallback. */
export function localiseLocator(loc: Locator, terms: TermMap): Locator {
  const extra = loc.strategies.map((s) => substituteStrategy(s, terms)).filter((s): s is LocatorStrategy => s !== null);
  if (extra.length === 0) return loc;
  return { ...loc, strategies: [...extra, ...loc.strategies] };
}

/** Widen a condition to hold under either vocabulary. */
export function localiseCondition(c: Condition, terms: TermMap): Condition {
  const localised = mapCondition(c, terms);
  return sameShape(c, localised) ? c : { kind: 'any', of: [localised, c] };
}

function mapCondition(c: Condition, terms: TermMap): Condition {
  switch (c.kind) {
    case 'textPresent':
    case 'textAbsent':
      return { ...c, value: substituteTerms(c.value, terms) };
    case 'visible':
    case 'notVisible':
      return { ...c, locator: localiseLocator(c.locator, terms) };
    case 'count':
      return { ...c, locator: localiseLocator(c.locator, terms) };
    case 'all':
      return { kind: 'all', of: c.of.map((x) => mapCondition(x, terms)) };
    case 'any':
      return { kind: 'any', of: c.of.map((x) => mapCondition(x, terms)) };
    case 'not':
      return { kind: 'not', of: mapCondition(c.of, terms) };
    default:
      return c;
  }
}

function sameShape(a: Condition, b: Condition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
