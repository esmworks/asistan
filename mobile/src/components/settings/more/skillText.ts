import type { SkillWarning } from '@yumakbot/shared';

/** A skill read from a SKILL.md file: front matter, then the instructions. */
export interface SkillFile {
  name: string;
  description: string;
  body: string;
}

/** `Weekly Report!` becomes `weekly-report`; what a skill name may hold. */
export function skillSlug(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
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

// The shared package's helpers sit behind a barrel the phone cannot load, so the same rules are
// written out here; the server checks a skill again when it is saved.

/** Reads the name and description from the front matter and keeps the rest as the body. */
export function parseSkillFile(text: string, fallbackName = ''): SkillFile {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fields = new Map<string, string>();
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    const lines = (m[1] ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i] ?? '');
      if (!kv) continue;
      let value = kv[2] ?? '';
      if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
        const more: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? ''))
          more.push((lines[++i] ?? '').trim());
        value = more.join(value.startsWith('|') ? '\n' : ' ');
      }
      fields.set((kv[1] ?? '').toLowerCase(), unquote(value));
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

const HIDDEN = /\u200B|\u200D|[\u202A-\u202E]|[\u2060-\u2064]|[\u2066-\u2069]|\uFEFF/;
const EMOJI_JOINER =
  /(\p{Extended_Pictographic}\p{M}*\uFE0F?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu;
const PIPE_SHELL =
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i;
const ENCODED =
  /base64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(|\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\bexec\s*\(\s*(?:base64\.b64decode|codecs\.decode)\s*\(/i;

/** What a skill's text may hide; empty when nothing looks off. */
export function skillWarnings(text: string): SkillWarning[] {
  const out: SkillWarning[] = [];
  if (HIDDEN.test(text.replace(/^\uFEFF/, '').replace(EMOJI_JOINER, '$1'))) out.push('hidden');
  if (PIPE_SHELL.test(text)) out.push('pipeShell');
  if (ENCODED.test(text)) out.push('encoded');
  return out;
}
