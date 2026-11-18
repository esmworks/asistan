import { maskCardNumbers, SECRET_TOKENS } from '@yumakbot/shared';

/**
 * Secrets a bot might copy into a note: memory reaches the model on every turn and shows in the
 * memory screen, so a key or password written there leaks wherever the note goes. Credentials
 * belong in the vault, which fills them in without the bot seeing them.
 *
 * Each pattern either is a whole token with a recognisable shape (its prefix tells what it is), or
 * a label such as `password:` followed by a value; for the latter only the value is replaced.
 */
const TOKENS = SECRET_TOKENS;

/**
 * A label naming a secret, then `:` or `=` (or "is"), then the value. The labels are English and
 * Turkish ("şifre", "parola", "anahtar"); the Turkish letters are escaped to keep the source ASCII.
 */
const LABELLED =
  /(?<![\p{L}\p{N}_])(password|passwd|pwd|passcode|pin|api[ _-]?key|secret|token|access[ _-]?key|client[ _-]?secret|şifre(?:si|m)?|parola(?:sı|m)?|(?:api )?anahtar(?:ı|ım)?)(\s*(?:[:=]|\bis\b|\bwas\b)\s*)(["'`]?)([^\s"'`,;]{4,})\3/giu;

/**
 * A variable set the shell's way whose name ends in what it holds: `PGPASSWORD=…`, `GITHUB_TOKEN=…`,
 * `AWS_SECRET_ACCESS_KEY=…`, `DB_PASS=…`. The label above wants its word to stand alone, which a
 * name like these never lets it.
 */
const VARIABLE =
  /\b([A-Z][A-Z0-9_]*?(?:PASSWORD|PASSWD|_PASS|_PWD|TOKEN|SECRET|SECRET_KEY|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)|PASS)(\s*=\s*)(["'`]?)([^\s"'`;&|]{4,})\3/g;

/** `text` with every secret it holds replaced by `marker`, and whether anything was replaced. */
export function redactSecrets(text: string, marker: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of TOKENS) out = out.replace(re, marker);
  out = maskCardNumbers(out, marker);
  out = out.replace(VARIABLE, (whole, name: string, sep: string, quote: string, value: string) =>
    value === marker ? whole : `${name}${sep}${quote}${marker}${quote}`,
  );
  out = out.replace(LABELLED, (whole, label: string, sep: string, quote: string, value: string) => {
    if (value === marker) return whole;
    // After "is" a plain word is more likely prose ("the token is valid") than a password.
    if (/\p{L}/u.test(sep) && /^\p{L}+$/u.test(value)) return whole;
    return `${label}${sep}${quote}${marker}${quote}`;
  });
  return { text: out, redacted: out !== text };
}

/**
 * The form two notes are compared in to find a repeat: case, spacing and closing punctuation do
 * not make a new fact.
 */
export function noteKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?…;,]+$/u, '')
    .trim();
}
