/**
 * ============================================================================
 * Origin allowlist matching
 * ============================================================================
 *
 * Lives here, not in the Playwright driver, because both the policy engine and
 * the network-level route guard must answer the question identically, and
 * neither layer should have to import the other.
 */

/**
 * An allowlist entry matches an exact origin, or an origin+path prefix that
 * ends at a path boundary. Raw `startsWith` let "http://host/t/summit" permit
 * "http://host/t/summit-archive/x", and a bare-host entry permit
 * "https://bank.example.evil.com/" — the allowlist is the outermost guard
 * against a run touching an institution it was never approved for.
 */
export function originPrefixMatches(u: URL, allowed: string): boolean {
  if (u.origin === allowed) return true;
  let base = allowed;
  try {
    const a = new URL(allowed);
    if (a.origin !== u.origin) return false;
    base = a.origin + a.pathname;
  } catch {
    if (!(u.origin + u.pathname).startsWith(allowed)) return false;
  }
  const withoutSlash = base.endsWith('/') ? base.slice(0, -1) : base;
  const full = u.origin + u.pathname;
  if (full === withoutSlash) return true;
  return full.startsWith(withoutSlash + '/');
}

