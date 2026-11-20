/**
 * The phrasings that make a bot's reply look like a promise of later action. This is the cheap
 * first look of the promise safety net: only a reply that matches is shown to a small model, so
 * most replies cost nothing extra. All of them are kept here, so a missed phrasing is added in one
 * place.
 *
 * Text and patterns are folded to plain lower-case ASCII first (Turkish letters included), which
 * is why the Turkish patterns below have no accents.
 */

const TURKISH_FOLD: Record<string, string> = { ı: 'i', ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c', İ: 'i' };

/** Lower-case, accent-free text with straight quotes, for matching. */
export function foldText(text: string): string {
  return text
    .replace(/[ıİğüşöç]/g, (c) => TURKISH_FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'");
}

/** A word that sets a later time or an event to wait for. */
const WHEN_TR =
  '(yarin|yarindan sonra|birazdan|sonra|daha sonra|ilerleyen|haftaya|gelecek hafta|aksam|sabah|bu hafta|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)';
const WHEN_EN =
  '(tomorrow|tonight|later|next week|this (evening|afternoon|week)|in (an|a few|a couple of|\\d+) (hour|minute|day)s?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

export const PROMISE_PATTERNS: RegExp[] = [
  // Turkish: "haber veririm", "bakip bildiririm", "yarin kontrol ederim", "fiyat dusunce soylerim".
  /\b(haber|bilgi) (veririm|vereyim|veririz|vereceg[ie]m|verecegiz)\b/,
  /\b(bildiririm|bildirecegim|bildirelim|hatirlatirim|hatirlatacagim|hatirlatayim)\b/,
  /\bbakip (haber|bilgi|donerim|yazarim|sana|size|soylerim)/,
  /\b(donerim|donecegim|yazarim|yazacagim|soylerim|soyleyecegim|dururum)\b.*\b(sonra|yarin|haber)\b/,
  /\b(takip ederim|takip edecegim|kontrol ederim|kontrol edecegim|izlerim|izleyecegim|goz kulak olurum|bakarim|bakacagim|arastiririm|arastiracagim)\b/,
  new RegExp(
    `\\b${WHEN_TR}\\b.*\\b(bakar|bakarim|bakip|donerim|donecegim|yazarim|kontrol|bildir|hatirlat|haber|gonderirim|paylasirim|hazirlarim|ararim)`,
  ),
  /\b(dusunce|duserse|gelince|olunca|degisince|cikinca|acilinca|ulasinca|hazir olunca)\b.*\b(soylerim|haber|bildir|yazarim|hatirlat|bakarim)/,
  /\b(soylerim|haber veririm|bildiririm)\b.*\b(dusunce|duserse|gelince|olunca|degisince|cikinca)\b/,
  // English: "I'll let you know", "I will check tomorrow", "get back to you", "keep you posted".
  /\b(i'll|i will|i'm going to|i am going to|let me|i can) (get back|let you know|check back|check in|check on|check|follow up|remind|look into|look at|ping|message|notify|tell you|circle back|keep an eye|watch|monitor|update you|report back|come back|send you|text you|email you|write you)\b/,
  /\b(get back to you|let you know|keep you posted|remind you|follow up with you|check back|circle back|ping you|notify you|update you)\b/,
  new RegExp(`\\b${WHEN_EN}\\b.*\\b(i'll|i will|i can|i'm going to)\\b`),
  new RegExp(`\\b(i'll|i will|i'm going to)\\b.*\\b${WHEN_EN}\\b`),
  /\b(once|when|as soon as|if) (it|the|that|this)\b.*\b(drops|changes|arrives|is ready|is available|goes|comes|updates|falls)\b.*\b(i'll|i will|let you know|tell you|notify)/,
];

/** Whether a reply sounds like a promise of later action; a hit only means a small model should look. */
export function looksLikePromise(reply: string): boolean {
  // A very long reply is looked at by its start and end, where a closing promise usually is.
  const text = foldText(reply.length > 6000 ? `${reply.slice(0, 3000)} ${reply.slice(-3000)}` : reply);
  return PROMISE_PATTERNS.some((p) => p.test(text));
}
