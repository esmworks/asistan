import { resolve, sep } from 'node:path';
import { commandParts, freePart } from '../services/shell-parts';
import { realPath } from '../workspace';
import { reachesOut } from './outside';

/** Package managers, and the subcommands that only install, remove or look at the project's packages. */
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PACKAGE_LOCAL = new Set([
  ...['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'outdated'],
  ...['ls', 'list', 'why', 'audit', 'dedupe', 'prune', 'test', 't'],
]);
/**
 * Project scripts a package manager may run by name: building, testing and checking. Any other
 * script (`release`, `deploy`) may publish or push.
 */
const CHECK_SCRIPT = /^(?:test|build|lint|typecheck|type-check|check|format|fmt|compile)(?::[\w:.-]+)?$/;

/** Git's subcommands that work on the local repository or only read from its remote. */
const GIT_LOCAL = new Set([
  ...['status', 'diff', 'log', 'show', 'add', 'commit', 'checkout', 'switch', 'branch', 'restore', 'stash'],
  ...['merge', 'rebase', 'reset', 'rev-parse', 'ls-files', 'blame', 'mv', 'rm', 'init', 'fetch', 'pull'],
  ...['cherry-pick', 'revert', 'tag', 'grep', 'describe', 'shortlog', 'clean', 'worktree'],
]);

/** Build tools whose listed subcommands build, test or tidy the project. */
const BUILDERS: Record<string, Set<string>> = {
  cargo: new Set(['build', 'test', 'check', 'fmt', 'clippy', 'doc']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'mod']),
};

/**
 * Programs that work on files where they are, or build, test or check code: no shells,
 * interpreters, `find`, `xargs`, `sed` or `awk`, which run whatever they are given; no `curl`, `ssh`
 * and the like, which talk to other hosts.
 */
const LOCAL_PROGRAMS = new Set([
  ...['ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'grep', 'rg', 'tree'],
  ...['du', 'df', 'pwd', 'cd', 'echo', 'printf', 'true', 'test', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir'],
  ...['ln', 'chmod', 'tar', 'gzip', 'gunzip', 'jq', 'date', 'which', 'basename', 'dirname', 'realpath'],
  ...['stat', 'file', 'nl', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'biome', 'pytest', 'ruff'],
  ...['black', 'mypy'],
]);

/** Programs whose operands are files they change: each must be in the bot's own folders. */
const CHANGES_FILES = new Set(['mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'chmod', 'tar']);

/**
 * Options that hand a program another program to start, a script to run or a place to send to:
 * `rg --pre`, `tar --to-command` / `--checkpoint-action=exec=…` / `-I`, `git rebase --exec` / `-x`,
 * `git grep -O`, `git fetch --upload-pack`, `sort --compress-program`, `npm --script-shell`.
 */
const RUNS_OPTION =
  /^--?(?:pre(?:-glob)?|[\w-]*(?:command|program|exec|script|shell|pager|action|hook|editor|pack|remote|rsh)[\w-]*)(?:=|$)/i;
/** Short options that do the same: `tar -I prog`, `tar -F script`, `git rebase -x`, `git grep -O`. */
function runsShort(program: string, sub: string, word: string): boolean {
  if (program === 'tar') return /^-[A-Za-z]*[IF]/.test(word);
  if (program === 'git' && sub === 'rebase') return /^-[A-Za-z]*x/.test(word);
  if (program === 'git' && sub === 'grep') return /^-[A-Za-z]*O/.test(word);
  return false;
}
/** Options that name a word above but only turn something off. */
const HARMLESS_OPTION = new Set(['--ignore-scripts', '--no-verify']);

/** One command of a line that works on the bot's own machine and sends nothing out by itself. */
function localPart(words: string[]): boolean {
  const [program = '', sub = '', ...rest] = words;
  // A program named by its path is another program in another folder (`./deploy.sh`).
  if (program.includes('/')) return false;
  const runs = (w: string) => !HARMLESS_OPTION.has(w) && (RUNS_OPTION.test(w) || runsShort(program, sub, w));
  if (words.slice(1).some(runs)) return false;
  if (LOCAL_PROGRAMS.has(program)) return true;
  // An option before the subcommand can point the program elsewhere (`git -C`, `npm --prefix`).
  if (sub.startsWith('-')) return false;
  if (program === 'git') return GIT_LOCAL.has(sub);
  if (PACKAGE_MANAGERS.has(program)) {
    if (!sub || PACKAGE_LOCAL.has(sub)) return true;
    if (sub === 'run' || sub === 'run-script') return CHECK_SCRIPT.test(rest[0] ?? '');
    // `pnpm typecheck` runs the project's script of that name.
    return program !== 'npm' && CHECK_SCRIPT.test(sub);
  }
  return !!BUILDERS[program]?.has(sub);
}

/** Whether `path`, links followed, is inside one of `dirs`. */
function inside(path: string, dirs: string[]): boolean {
  const at = realPath(path);
  return dirs.some((d) => {
    const dir = realPath(d);
    return at === dir || at.startsWith(dir + sep);
  });
}

/** A word as the shell would hand it on: quotes taken off. */
const unquoted = (w: string) => w.replace(/^(["'])(.*)\1$/s, '$2');

/**
 * Whether a shell command only builds, tests, installs packages for, or changes files and the git
 * repository in the bot's own folders: every command in the line is one of those, none names another
 * host or hands a program code to run, and every file it changes is in `dirs` (`cd` followed). A
 * line the shell would read in other ways (substitutions, variables, redirects into files) does not
 * count.
 */
export function staysOnBox(command: string, cwd: string, dirs: string[]): boolean {
  if (reachesOut('Bash', { command })) return false;
  const parts = commandParts(command);
  if (!parts?.length) return false;
  let here = cwd;
  for (const part of parts) {
    const words = part.split(' ').map(unquoted);
    if (words.some((w) => w.startsWith('~'))) return false;
    if (words[0] === 'cd') {
      if (!words[1] || words[1] === '-') return false;
      here = resolve(here, words[1]);
      if (!inside(here, dirs)) return false;
      continue;
    }
    if (freePart(part)) continue;
    if (!localPart(words)) return false;
    if (CHANGES_FILES.has(words[0]!)) {
      const operands = words.slice(1).filter((w) => !w.startsWith('-'));
      if (!operands.every((w) => inside(resolve(here, w.replace(/[*?[].*$/, '') || '.'), dirs))) return false;
    }
  }
  return true;
}

/** File tools whose path a step on the bot's own machine keeps to its own folders. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Whether a step stays in the bot's own folders on a server of its own: a command that only builds,
 * tests, installs or does local git work there (`staysOnBox`), or a file written there. Such a step
 * changes nothing of the person's; a step that reaches anything else goes by the level.
 */
export function ownBoxStep(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  dirs: string[],
): boolean {
  if (toolName === 'Bash') return typeof input.command === 'string' && staysOnBox(input.command, cwd, dirs);
  if (!FILE_TOOLS.has(toolName)) return false;
  const path = [input.file_path, input.notebook_path, input.path].find(
    (p): p is string => typeof p === 'string' && !!p.trim(),
  );
  return !!path && inside(resolve(cwd, path), dirs);
}
