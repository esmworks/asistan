/**
 * Secrets a bot might copy into a note: memory reaches the model on every turn and shows in the
 * memory screen, so a key or password written there leaks wherever the note goes. Credentials
 * belong in the vault, which fills them in without the bot seeing them.
 *
 * Each pattern either is a whole token with a recognisable shape (its prefix tells what it is), or
 * a label such as `password:` followed by a value; for the latter only the value is replaced.
 */
const TOKENS: RegExp[] = [
  // PEM private keys, header to footer.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Anthropic, OpenAI and other `sk-` keys.
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens.
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Discord bot tokens: the bot's id in base64, a time stamp and a signature.
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
  // Stripe secret and restricted keys.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A bearer token in a header.
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

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
