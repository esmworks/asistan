/**
 * Keys and tokens with a shape of their own: the prefix tells what each is. Shared by what keeps
 * them out of the bots' notes and replies, and by the chat box, which warns before one is sent.
 */
export const SECRET_TOKENS: readonly RegExp[] = [
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

/** Whether a string of digits passes the check digit every payment card number carries. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'troy' | 'discover' | 'other';

/** The card network a number belongs to, by its first digits. */
export function cardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^9792/.test(digits)) return 'troy';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'discover';
  return 'other';
}

/**
 * Runs of digits in text, in groups split by single spaces or dashes. A card number is looked for
 * inside each run, group by group, so one written beside other numbers ("4242 4242 4242 4242
 * 12/34") is found as well as one standing alone.
 */
const DIGIT_RUN = /(?<![\d-])\d+(?:[ -]\d+)*/g;

/**
 * Whether these digits are a card number: 13 to 19 of them, starting as a known card network's
 * do, passing the check digit. Other long numbers (an order number, a phone number, a device's
 * serial) seldom pass all three.
 */
const isCardNumber = (digits: string) =>
  digits.length >= 13 && digits.length <= 19 && cardBrand(digits) !== 'other' && luhn(digits);

/** A run of digit groups with each card number in it replaced by `marker`. */
function maskRun(run: string, marker: string): string {
  const parts = run.split(/([ -])/);
  const groups = parts.filter((_, i) => i % 2 === 0);
  const out: string[] = [];
  let i = 0;
  while (i < groups.length) {
    let digits = '';
    let end = -1;
    for (let j = i; j < groups.length && digits.length < 19; j++) {
      digits += groups[j];
      if (isCardNumber(digits)) end = j;
    }
    if (end < 0) {
      out.push(groups[i]!, parts[2 * i + 1] ?? '');
      i++;
      continue;
    }
    out.push(marker, parts[2 * end + 1] ?? '');
    i = end + 1;
  }
  return out.join('');
}

/** `text` with every payment card number in it replaced by `marker`. */
export function maskCardNumbers(text: string, marker: string): string {
  return text.replace(DIGIT_RUN, (run) => maskRun(run, marker));
}

/** Whether `text` holds a key or token of a known shape, or a payment card number. */
export function hasSecretShape(text: string): boolean {
  return (
    SECRET_TOKENS.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(text)) ||
    maskCardNumbers(text, '\u0000') !== text
  );
}

/** `text` with every key or token of a known shape, and every card number, replaced by `marker`. */
export function maskSecretShapes(text: string, marker: string): string {
  let out = text;
  for (const re of SECRET_TOKENS) out = out.replace(re, marker);
  return maskCardNumbers(out, marker);
}
