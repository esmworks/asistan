/**
 * What a skill's text may hide. A skill is instructions a bot follows, often pasted in from the
 * web, so its text is checked for the tricks that make it do something other than what it reads:
 * characters nobody sees, a download piped straight into a shell, and code run from an encoding.
 */
export type SkillWarning = 'hidden' | 'pipeShell' | 'encoded';

/**
 * Zero-width and direction-changing characters: text that reads one way and says another. The
 * joiner inside an emoji sequence, a file's leading byte-order mark, and the marks some languages
 * write with (ZWNJ, LRM, RLM) are not counted.
 */
const HIDDEN = /\u200B|\u200D|[\u202A-\u202E]|[\u2060-\u2064]|[\u2066-\u2069]|\uFEFF/;
const EMOJI_JOINER =
  /(\p{Extended_Pictographic}\p{M}*\uFE0F?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu;
/** A download handed to a shell as it arrives: curl … | sh, wget -O- … | bash, iwr … | iex. */
const PIPE_SHELL =
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i;
/** Code run from base64 or another encoding, so what runs cannot be read in the skill. */
const ENCODED =
  /base64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(|\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\bexec\s*\(\s*(?:base64\.b64decode|codecs\.decode)\s*\(/i;

/** The warnings for a skill's text; empty when nothing looks off. */
export function skillWarnings(text: string): SkillWarning[] {
  const out: SkillWarning[] = [];
  if (HIDDEN.test(text.replace(/^\uFEFF/, '').replace(EMOJI_JOINER, '$1'))) out.push('hidden');
  if (PIPE_SHELL.test(text)) out.push('pipeShell');
  if (ENCODED.test(text)) out.push('encoded');
  return out;
}
