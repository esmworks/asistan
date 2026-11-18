import type { VaultImportSkip } from '@yumakbot/shared';
import { totpSecret } from '../totp';

/** The most rows one file may bring; a longer one is refused rather than read in part. */
export const MAX_IMPORT_ROWS = 5000;

/**
 * RFC 4180 rows: fields split by commas, a field in double quotes may hold commas, line breaks and
 * doubled quotes. A byte order mark and the line endings of any system are taken in stride.
 */
export function csvRows(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * The column names each value goes by in the files browsers and password managers write, in the
 * order they are tried; compared without case, spaces or underscores.
 */
const COLUMNS = {
  url: ['url', 'loginuri', 'website', 'web site', 'loginurl', 'origin', 'originurl', 'hostname', 'uri'],
  username: ['username', 'loginusername', 'user', 'login', 'email', 'emailaddress', 'loginemail'],
  password: ['password', 'loginpassword', 'pass'],
  totp: ['totp', 'otpauth', 'logintotp', 'otp', 'onetimepassword', 'authenticator', 'twofactorsecret'],
  type: ['type', 'itemtype'],
} as const;

const norm = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, '');

/** A sign-in read from a file, with the line it came from (counting the header as 1). */
export interface ImportedLogin {
  line: number;
  url: string;
  username: string;
  password: string;
  totp: string | null;
}

/**
 * The sign-ins in an exported passwords file, and the lines that are not one: a row of another kind
 * (a card or a note in a manager's export), or one with neither an address nor a password.
 */
export function loginsFromCsv(text: string): {
  logins: ImportedLogin[];
  skipped: VaultImportSkip[];
  tooMany: boolean;
  /** The file has no column that holds an address or one that holds a password. */
  unknown: boolean;
} {
  const rows = csvRows(text);
  const head = (rows[0] ?? []).map(norm);
  const find = (names: readonly string[]) => {
    for (const n of names) {
      const i = head.indexOf(norm(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const at = {
    url: find(COLUMNS.url),
    username: find(COLUMNS.username),
    password: find(COLUMNS.password),
    totp: find(COLUMNS.totp),
    type: find(COLUMNS.type),
  };
  // Some exports keep both: the username, and the address it was made with.
  const email = head.indexOf('email');
  if (at.url < 0 || at.password < 0) return { logins: [], skipped: [], tooMany: false, unknown: true };
  const body = rows.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { logins: [], skipped: [], tooMany: true, unknown: false };
  const logins: ImportedLogin[] = [];
  const skipped: VaultImportSkip[] = [];
  body.forEach((r, i) => {
    const line = i + 2;
    const cell = (j: number) => (j >= 0 ? (r[j] ?? '').trim() : '');
    const url = cell(at.url);
    const username = cell(at.username) || (email >= 0 ? cell(email) : '');
    const kind = cell(at.type).toLowerCase();
    if (kind && kind !== 'login') {
      skipped.push({ line, site: url, username, reason: 'notLogin' });
      return;
    }
    const password = at.password >= 0 ? (r[at.password] ?? '') : '';
    if (!password) {
      skipped.push({ line, site: url, username, reason: 'noPassword' });
      return;
    }
    logins.push({ line, url, username, password, totp: cell(at.totp) || null });
  });
  return { logins, skipped, tooMany: false, unknown: false };
}

/** An authenticator setup as the vault keeps it, or null when the text is not one. */
export const importedTotp = (raw: string | null) => (raw ? totpSecret(raw) : null);

/** A `NAME=value` line of a `.env` file. */
export interface EnvEntry {
  line: number;
  name: string;
  value: string;
}

/**
 * The entries of a `.env` file: `NAME=value` lines, an `export` in front allowed, a value in
 * quotes taken without them, comments and blank lines left out. A later line with the same name
 * wins, as the tools that read these files do.
 */
export function envEntries(text: string): EnvEntry[] {
  const byName = new Map<string, EnvEntry>();
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
      if (!m) return;
      let value = m[2]!.trim();
      const q = value[0];
      if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
        value = value.slice(1, -1);
        if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      } else value = value.replace(/\s+#.*$/, '');
      if (!value) return;
      byName.set(m[1]!, { line: i + 1, name: m[1]!, value });
    });
  return [...byName.values()];
}
