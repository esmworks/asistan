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
  /\bdd\b[^\n;&|]*\bof=\/dev\/(?:sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd|md\d|dm-|mapper\/|root\b)/i,
  />\s*\/dev\/(?:sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd|md\d|dm-|mapper\/)\w*/i,
  /\b(?:wipefs|shred)\b[^\n;&|]*\/dev\//i,
  // A fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Opening up or taking over the whole file system.
  /\bchmod\s+(?:-[a-z]*\s+)*-[a-z]*R[a-z]*\s+(?:0?777|a\+rwx)\s+\/(?=\s|$)/i,
  /\bchown\s+(?:-[a-z]*\s+)*-[a-z]*R[a-z]*\s+\S+\s+\/(?=\s|$)/i,
  // Code run through an interpreter that removes a tree at the root or a home folder.
  /\brmtree\(\s*["'`](?:\/|~|\$HOME)[^"'`]{0,1}["'`]/i,
  /\brm(?:Sync)?\(\s*["'`](?:\/|~|\$HOME)[^"'`]{0,1}["'`][^)]*\brecursive\s*:\s*true/i,
  // Stopping the machine, or every process at once.
  /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|poweroff|halt|reboot)\b/i,
  /\bkill\s+-(?:9|KILL)\s+-1\b/i,
];

/**
 * What a recursive removal must never be pointed at: the root, a folder right under it (`/etc`,
 * `/home`, `/data`), a home folder (`~`, `$HOME`, `/home/me`, `/Users/me`), or everything in one.
 * A folder further down (`/tmp/build`, `~/project/cache`) is ordinary work.
 */
export function precious(path: string): boolean {
  const p = path
    .replace(/^\$\{HOME\}|^\$HOME/, '~')
    .replace(/(?:\/\.?|\/\*)+$/, '')
    .replace(/\/{2,}/g, '/');
  if (p === '' || p === '~' || p === '/') return true;
  if (/^~[\w.-]*$/.test(p)) return true;
  if (/^\/[^/]+$/.test(p)) return true;
  return /^\/(?:home|Users|var\/home)\/[^/]+$/.test(p);
}

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
    if (recursive && args.some((a) => !a.startsWith('-') && precious(a))) return true;
  }
  return false;
}

/**
 * Whether a piece of a command line deletes what `find` finds under the root or a home folder
 * (`find / -delete`, `find ~ -exec rm -rf {} +`).
 */
function findWipes(segment: string): boolean {
  const words = segment.replace(/["']/g, ' ').trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'find' || !COMMAND_START.has(i ? words[i - 1]! : '')) continue;
    const rest = words.slice(i + 1);
    const firstOption = rest.findIndex((w) => w.startsWith('-'));
    const roots = firstOption < 0 ? rest : rest.slice(0, firstOption);
    const removes = rest.some(
      (w, j) =>
        w === '-delete' ||
        (/^-(?:exec|execdir|ok|okdir)$/.test(w) && /(?:^|\/)(?:rm|shred|unlink)$/.test(rest[j + 1] ?? '')),
    );
    if (removes && roots.some(precious)) return true;
  }
  return false;
}

/**
 * Whether a piece runs `chmod -R` or `chown -R` on the root, a folder right under it or a home
 * folder: that takes the machine, or the person's files, away from their owner.
 */
function retakes(segment: string): boolean {
  const words = segment.replace(/["']/g, ' ').trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:chmod|chown|chgrp)$/.test(words[i]!) || !COMMAND_START.has(i ? words[i - 1]! : '')) continue;
    const args = words.slice(i + 1);
    const recursive = args.some((a) => a === '--recursive' || /^-[a-z]*R/.test(a));
    const operands = args.filter((a) => !a.startsWith('-')).slice(1);
    if (recursive && operands.some(precious)) return true;
  }
  return false;
}

/** A program that runs the code it is given (`sh -c "…"`, `python3 -c "…"`, `node -e "…"`). */
const INLINE_CODE =
  /\b(?:ba|z|da|k|fi)?sh\s+-\w*c\b|\b(?:python[\d.]*|node|nodejs|deno|bun|perl|ruby|php)\b[^\n]*?\s-(?:c|e|r|-eval)\b/i;

/** Whether a command hands code to a program to run (`sh -c`, `python3 -c`, `node -e`). */
export const runsInlineCode = (command: string): boolean => INLINE_CODE.test(command.replace(/\\\n/g, ' '));

/** Whether a shell command is one that must never run, whoever allowed it. */
export function catastrophic(command: string): boolean {
  const flat = command.replace(/\\\n/g, ' ');
  const pieces = flat.split(/&&|\|\||[;&|\n]/);
  if (pieces.some((p) => wipes(p) || findWipes(p) || retakes(p))) return true;
  // Code handed to an interpreter starts programs from inside its own syntax: a call such as
  // `os.system("rm -rf /")` or `subprocess.run(["rm", "-rf", "/"])` starts a command there.
  if (INLINE_CODE.test(flat)) {
    const inner = flat
      .replace(/\b(?:system|popen|exec\w*|spawn\w*|call|run|check_output)\b/g, ' ; ')
      .replace(/[()[\]{},`]/g, ' ');
    if (inner.split(/&&|\|\||[;&|\n]/).some((p) => wipes(p) || findWipes(p))) return true;
  }
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
export function readsOnlyWithin(
  command: string,
  cwd: string,
  dirs: string[],
  except: string[] = [],
): boolean {
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
  const off = except.map((d) => realPath(d));
  const within = (at: string, d: string) => at === d || at.startsWith(d + sep);
  return paths.every((p) => {
    // A pattern reaches whatever its folder holds: `th*` in the bot's folder matches `threads`.
    const star = p.indexOf('*');
    const base = star < 0 ? p : p.slice(0, p.lastIndexOf('/', star) + 1);
    const at = realPath(resolve(cwd, base || '.'));
    if (!inside.some((d) => within(at, d))) return false;
    // A folder left out (other conversations, the desktop's home) is never read through a folder
    // above it (`grep -r`, `ls -R`), and inside it counts only where one of `dirs` holds the path:
    // the conversation's own folder among the others.
    return off.every(
      (o) =>
        !within(o, at) && (!within(at, o) || inside.some((d) => within(d, o) && d !== o && within(at, d))),
    );
  });
}

/** What a read-only line may send away its errors and output to: nowhere. */
const DISCARDED = /\s*(?:2>\/dev\/null|>\/dev\/null|2>&1)(?=\s|$|[;|&])/g;

/**
 * Whether a whole shell line only reads files inside `dirs`, as `readsOnlyWithin` reads one
 * command: commands chained with `;`, `&&`, `||` or new lines, each a reading program whose output
 * may go through more readers (`ls … | grep …`), errors or output thrown away (`2>/dev/null`), and
 * plain variables set on the line itself (`B=/data/…; ls $B`), put in place before each command is
 * judged. Anything else (a substitution, a redirect into a file, a variable from elsewhere, a
 * program that is not a reader) makes the line not a plain read.
 */
export function readsOnlyLine(command: string, cwd: string, dirs: string[], except: string[] = []): boolean {
  const line = command.replace(/\\\n/g, ' ').replace(DISCARDED, '');
  // Substitutions, redirects and background jobs; `&&` is a chain.
  if (/[`<>(){}\\'"!#~]/.test(line.replace(/\$\{(\w+)\}/g, '$$$1')) || /(^|[^&])&(?!&)/.test(line))
    return false;
  const vars = new Map<string, string>();
  const statements = line.split(/&&|\|\||;|\n/).map((x) => x.trim());
  if (!statements.some(Boolean)) return false;
  for (const statement of statements) {
    if (!statement) continue;
    const expanded = statement.replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (_, a: string | undefined, b: string | undefined) => {
        const v = vars.get((a ?? b)!);
        return v === undefined ? '\u0000' : v;
      },
    );
    if (expanded.includes('\u0000') || expanded.includes('$')) return false;
    const set = /^([A-Za-z_]\w*)=(\S*)$/.exec(expanded);
    if (set) {
      if (!/^[\w./,:=@%+-]*$/.test(set[2]!)) return false;
      vars.set(set[1]!, set[2]!);
      continue;
    }
    if (!expanded.split('|').every((stage) => readsOnlyWithin(stage.trim(), cwd, dirs, except))) return false;
  }
  return true;
}
