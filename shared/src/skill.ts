/** A skill read from a SKILL.md file: YAML-like front matter, then the instructions. */
export interface SkillFile {
  name: string;
  description: string;
  body: string;
}

/** `Weekly Report!` → `weekly-report`; what a skill name may hold. */
export function skillSlug(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

const unquote = (v: string) => {
  const s = v.trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;
};

/**
 * Reads the `name` and `description` from the front matter and keeps the rest as the body. A file
 * without front matter takes its name from `fallbackName` and its description from the first
 * heading or line. Folded (`>`) and literal (`|`) descriptions spanning several lines are joined.
 */
export function parseSkillFile(text: string, fallbackName = ''): SkillFile {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fields = new Map<string, string>();
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    const lines = m[1]!.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
      if (!kv) continue;
      let value = kv[2]!;
      if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
        const more: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) more.push(lines[++i]!.trim());
        value = more.join(value.startsWith('|') ? '\n' : ' ');
      }
      fields.set(kv[1]!.toLowerCase(), unquote(value));
    }
  }
  body = body.trim();
  const firstLine =
    body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? '';
  return {
    name: skillSlug(fields.get('name') || fallbackName.replace(/\.(md|markdown|txt)$/i, '') || firstLine),
    description: (fields.get('description') || firstLine).slice(0, 1024),
    body,
  };
}
