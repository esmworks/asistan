/** Lower case without accents, the dotless ı as i: "Sınır" and "sinir" read the same. */
function fold(s: string): string {
  return s.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** Whether every word typed is in a section's name or keywords, ignoring case and accents. */
export function settingsMatch(query: string, haystack: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const text = fold(haystack);
  return words.every((w) => text.includes(w));
}
