/** Words that name every member of a room at once, after an `@`. */
export const EVERYONE_MENTIONS = ['everyone', 'herkes', 'hepiniz'] as const;

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The bots a text names with `@Name`, in the order they first appear. A name may have spaces in it;
 * the longest name that fits wins, so "@Ada Lovelace" is not taken for a bot called "Ada". Case is
 * ignored (Turkish casing too). `everyone` is set by `@everyone` and its synonyms.
 */
export function findMentions<T extends { id: string; name: string }>(
  text: string,
  bots: readonly T[],
): { ids: string[]; everyone: boolean } {
  const lower = (s: string) => s.toLocaleLowerCase('tr');
  const named = bots
    .map((b) => ({ id: b.id, name: lower(b.name.trim()) }))
    .filter((b) => b.name)
    .sort((a, b) => b.name.length - a.name.length);
  const ids: string[] = [];
  let everyone = false;
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    // An address (ada@example.com) is not a mention.
    if (i > 0 && WORD.test(text[i - 1]!)) continue;
    const rest = lower(text.slice(i + 1, i + 1 + 80));
    const ends = (n: number) => n >= rest.length || !WORD.test(rest[n]!);
    if (EVERYONE_MENTIONS.some((w) => rest.startsWith(w) && ends(w.length))) {
      everyone = true;
      continue;
    }
    const hit = named.find((b) => rest.startsWith(b.name) && ends(b.name.length));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, everyone };
}
