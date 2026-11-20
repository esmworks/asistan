import type { Message } from '@leafbot/shared';

/**
 * A conversation as a Markdown document: a heading with its name, then each message of the
 * person and the bots under its author and time. Cards, markers and errors are left out; a
 * message's files are listed by name.
 */
export function conversationMarkdown(
  title: string,
  messages: readonly Message[],
  opts: { author(m: Message): string; time(iso: string): string },
): string {
  const out = [`# ${title}`, ''];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const files = ((m.props as { files?: { name: string }[] }).files ?? []).map((f) => f.name);
    if (!m.text.trim() && !files.length) continue;
    out.push(`## ${opts.author(m)} · ${opts.time(m.createdAt)}`, '');
    if (m.text.trim()) out.push(m.text.trim(), '');
    for (const name of files) out.push(`- 📎 ${name}`);
    if (files.length) out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** A file name from a conversation's name: no characters file systems refuse, not too long. */
export function exportFileName(title: string, day: string): string {
  const base = [...title]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'conversation'} ${day}.md`;
}
