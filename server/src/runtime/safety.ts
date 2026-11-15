import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { realPath } from '../workspace';

/**
 * Shell commands no permission mode, rule or card may let through: they wipe a disk or a whole
 * home folder, stop the machine, or take every process down. The sandbox limits what a command
 * reaches, but a bot on a computer of its own, or a rule written too wide, should still never run
 * these. Matching is deliberately narrow, so ordinary work is never refused.
 */
const NEVER: RegExp[] = [
  /\brm\b[^\n;&|]*--no-preserve-root/i,
  // Making a file system on, or writing raw data over, a disk.
  /\bmkfs(?:\.\w+)?\s/i,
  /\bdd\b[^\n;&|]*\bof=\/dev\/(?:sd|hd|nvme|disk|mmcblk|vd|xvd)/i,
  />\s*\/dev\/(?:sd|hd|nvme|disk|mmcblk|vd|xvd)\w*/i,
  /\b(?:wipefs|shred)\b[^\n;&|]*\/dev\//i,
  // A fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Opening up or taking over the whole file system.
  /\bchmod\s+(?:-[a-z]*\s+)*-[a-z]*R[a-z]*\s+(?:0?777|a\+rwx)\s+\/(?=\s|$)/i,
  /\bchown\s+(?:-[a-z]*\s+)*-[a-z]*R[a-z]*\s+\S+\s+\/(?=\s|$)/i,
  // Stopping the machine, or every process at once.
  /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|poweroff|halt|reboot)\b/i,
  /\bkill\s+-(?:9|KILL)\s+-1\b/i,
];

/** What `rm -r` must never be pointed at: the root, the home folder, or everything in either. */
const PRECIOUS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '$HOME/',
  '$HOME/*',
  '${HOME}',
  '${HOME}/',
  '${HOME}/*',
]);
/** Words after which `rm` is the command being run, not text (`git commit -m "rm …"`). */
const COMMAND_START = new Set([
  '',
  'sudo',
  'doas',
  '-c',
  'xargs',
  'exec',
  'then',
  'do',
  'else',
  'nohup',
  'time',
]);

/** Whether a piece of a command line runs a recursive `rm` on the root or the home folder. */
function wipes(segment: string): boolean {
  const words = segment.replace(/["']/g, ' ').trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'rm' || !COMMAND_START.has(i ? words[i - 1]! : '')) continue;
    const args = words.slice(i + 1);
    const flags = args.filter((a) => a.startsWith('-'));
    const recursive = flags.some((f) => f === '--recursive' || (!f.startsWith('--') && /r/i.test(f)));
    if (recursive && args.some((a) => PRECIOUS.has(a))) return true;
  }
  return false;
}

/** Whether a shell command is one that must never run, whoever allowed it. */
export function catastrophic(command: string): boolean {
  const flat = command.replace(/\\\n/g, ' ');
  if (flat.split(/&&|\|\||[;&|\n]/).some(wipes)) return true;
  return NEVER.some((re) => re.test(flat));
}

/** Programs that only read, as a bot uses them on its own files. */
const READERS = new Set(['cat', 'head', 'tail', 'grep', 'rg', 'ls', 'wc', 'nl', 'stat', 'file', 'sed']);

/**
 * Whether a shell command only reads files inside `dirs`: one reading program (`cat`, `head`,
 * `grep`, `ls`, `sed -n` and the like), plain words alone (no pipes, redirects, substitutions or
 * variables), and every path, links followed, inside one of the folders. Such a read of the bot's
 * own instructions, skills or conversation files needs no card at any approval level.
 */
export function readsOnlyWithin(command: string, cwd: string, dirs: string[]): boolean {
  if (!/^[\w\s./,:=@%+*-]+$/.test(command) || command.includes('..')) return false;
  const [program, ...args] = command.trim().split(/\s+/);
  if (!program || !READERS.has(program)) return false;
  // An option naming a file or a program (`--file=…`, `rg --pre`) could reach past the folders.
  if (args.some((a) => a.startsWith('-') && (/[/=]/.test(a) || a.startsWith('--pre')))) return false;
  // `sed` only as `sed -n 1,20p <files>`: its other commands can write files or run programs.
  if (program === 'sed' && (args[0] !== '-n' || !/^\d+(,\d+)?p$/.test(args[1] ?? ''))) return false;
  const paths = (program === 'sed' ? args.slice(2) : args).filter(
    (a) => !a.startsWith('-') && (a.includes('/') || a.includes('.') || existsSync(resolve(cwd, a))),
  );
  const inside = dirs.map((d) => realPath(d));
  return paths.every((p) => {
    const at = realPath(resolve(cwd, p.replace(/\*.*$/, '') || '.'));
    return inside.some((d) => at === d || at.startsWith(d + sep));
  });
}
