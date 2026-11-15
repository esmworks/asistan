/** Commands the message box runs itself when the whole text is `/name`. */
export const SLASH_COMMANDS = [
  'new',
  'find',
  'stop',
  'routine',
  'memory',
  'settings',
  'panel',
  'export',
  'shortcuts',
  'today',
  'goal',
] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

/**
 * The command name being typed, when the text is nothing but `/` and letters; null otherwise,
 * so a message that starts with a path (`/etc/hosts …`) is never taken for a command.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/([\p{L}]*)$/u.exec(text);
  return m ? m[1]!.toLocaleLowerCase('tr') : null;
}

/** `/goal …` typed as a whole message: the goal to set (empty clears it); null for any other text. */
export function goalCommand(text: string): string | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] ?? '').trim() : null;
}

/**
 * The commands matching `query`, by their name or the words of their label (in the app's
 * language); those whose name starts with it come first.
 */
export function slashMatches(
  query: string,
  label: (c: SlashCommand) => string,
  available: (c: SlashCommand) => boolean = () => true,
): SlashCommand[] {
  const q = query.toLocaleLowerCase('tr');
  return SLASH_COMMANDS.filter(
    (c) => available(c) && (c.startsWith(q) || label(c).toLocaleLowerCase('tr').includes(q)),
  ).sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)));
}
