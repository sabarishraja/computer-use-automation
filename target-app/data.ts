/**
 * Synthetic fixture data. No real PII: names are invented, numbers are sequential.
 */
export type Account = { number: string; type: string; balance: number; status: string };
export type Member = {
  number: string;
  name: string;
  since: string;
  branch: string;
  restricted: boolean;
  accounts: Account[];
};

export const MEMBERS: Record<string, Member> = {
  '123456': {
    number: '123456',
    name: 'DELACROIX, RENE J',
    since: '04/11/2009',
    branch: 'RIVERSIDE 002',
    restricted: false,
    accounts: [
      { number: '0001', type: 'SHARE SAVINGS', balance: 4820.15, status: 'OPEN' },
      { number: '0010', type: 'CHECKING', balance: 1290.44, status: 'OPEN' },
      { number: '0301', type: 'AUTO LOAN', balance: -11204.0, status: 'OPEN' },
    ],
  },
  '234567': {
    number: '234567',
    name: 'OKONKWO, ADAEZE',
    since: '09/02/2015',
    branch: 'DOWNTOWN 001',
    restricted: false,
    accounts: [
      { number: '0001', type: 'SHARE SAVINGS', balance: 152.9, status: 'OPEN' },
      { number: '0002', type: 'VACATION CLUB', balance: 900.0, status: 'DORMANT' },
    ],
  },
  '345678': {
    number: '345678',
    name: 'HALVORSEN, PETRA M',
    since: '01/30/2021',
    branch: 'RIVERSIDE 002',
    restricted: false,
    accounts: [{ number: '0001', type: 'SHARE SAVINGS', balance: 78244.02, status: 'OPEN' }],
  },
  '999999': {
    number: '999999',
    name: 'RESTRICTED RECORD',
    since: '—',
    branch: '—',
    restricted: true,
    accounts: [],
  },
};

/** The only credentials this app accepts. Deliberately fake and non-secret. */
export const DEMO_OPERATOR = { id: 'OPR001', password: 'training-only' };
