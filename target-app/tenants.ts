/**
 * Two tenants running the SAME underlying vendor product ("MemberLink Core Servicing"),
 * configured, branded and versioned differently.
 *
 * This exists so that cross-tenant artifact reuse can actually be demonstrated rather
 * than merely described: `summit` is the tenant the capability is recorded against,
 * `harbor` is a second institution on a later minor version with different terminology.
 */
export type TenantConfig = {
  id: string;
  institution: string;
  productVersion: string;
  /** Terminology differences — the classic per-tenant configuration axis. */
  terms: {
    subject: string;        // "Member" vs "Customer"
    subjectPlural: string;
    searchButton: string;   // "Search" vs "Find"
    balanceLabel: string;
  };
  theme: { bar: string; accent: string };
  /** Harbor interposes a disclosure interstitial after sign-on. */
  alwaysInterstitial: boolean;
};

export const TENANTS: Record<string, TenantConfig> = {
  summit: {
    id: 'summit',
    institution: 'Summit Credit Union',
    productVersion: '3.1.7',
    terms: {
      subject: 'Member',
      subjectPlural: 'Members',
      searchButton: 'Search',
      balanceLabel: 'Current Balance',
    },
    theme: { bar: '#1f3864', accent: '#c9d6ea' },
    alwaysInterstitial: false,
  },
  harbor: {
    id: 'harbor',
    institution: 'Harbor First Bank',
    productVersion: '3.4.2',
    terms: {
      subject: 'Customer',
      subjectPlural: 'Customers',
      searchButton: 'Find',
      balanceLabel: 'Available Balance',
    },
    theme: { bar: '#3d1f1f', accent: '#eadcc9' },
    alwaysInterstitial: true,
  },
};

export function tenantOr404(id: string | undefined): TenantConfig | null {
  if (!id) return null;
  return TENANTS[id] ?? null;
}
