/** Redirects that only join or drop a command's own output, and send nothing into a file. */
const HARMLESS_REDIRECT = /^(?:[012]?>&[012]|[012]?>\s*\/dev\/null|&>\s*\/dev\/null)/;

/**
 * The commands a shell line runs one after another or piped into each other, each as written:
 * `cd yb && grep -n "a|b" f.ts | head -3` is `cd yb`, `grep -n "a|b" f.ts` and `head -3`. A rule
 * can then be kept for, and checked against, each command on its own.
 *
 * Null when the line does more than run commands in a row, so its parts would not say what it
 * does: a substitution or variable (`$(…)`, `` `…` ``, `$HOME`), a backslash outside quotes, a
 * redirect into or out of a file, a group or subshell, a command sent to the background, or an
 * unclosed quote. Output joined or dropped (`2>&1`, `>/dev/null`) is taken out of the part.
 */
export function commandParts(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // Spaces between words count as one; inside quotes they are kept as written.
  const cut = () => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      current += c;
      continue;
    }
    if (quote === '"') {
      // Inside double quotes the shell still expands `$` and backticks.
      if (c === '$' || c === '`') return null;
      if (c === '\\') {
        current += c + (command[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') quote = null;
      current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '$' || c === '`' || c === '\\' || '(){}<'.includes(c)) return null;
    const redirect = HARMLESS_REDIRECT.exec(command.slice(i));
    // A digit right before `>` belongs to the redirect, not to the word before it (`2>&1`).
    if (redirect && (!/\d/.test(c) || !/\S/.test(command[i - 1] ?? ' '))) {
      i += redirect[0].length - 1;
      if (!current.endsWith(' ')) current += ' ';
      continue;
    }
    if (c === '>') return null;
    if (c === '&') {
      if (command[i + 1] !== '&') return null;
      cut();
      i++;
      continue;
    }
    if (c === '|') {
      // `|&` sends errors down the pipe as well: fine; `||` runs the next one on failure.
      if (command[i + 1] === '|' || command[i + 1] === '&') i++;
      cut();
      continue;
    }
    if (c === ';' || c === '\n') {
      cut();
      continue;
    }
    if (/\s/.test(c)) {
      if (!current.endsWith(' ')) current += ' ';
      continue;
    }
    current += c;
  }
  if (quote) return null;
  cut();
  return parts;
}

/** Programs that only pass on, count or sort what is piped into them. */
const FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'grep']);

/**
 * A part that needs no rule of its own: it changes nothing and reads nothing a rule for the other
 * parts would not. `cd` only moves where the next parts run; `echo` writes to the output (a
 * redirect into a file is never a part); a filter with no file named reads only what is piped in.
 */
export function freePart(part: string): boolean {
  const [program, ...args] = part.split(' ');
  if (program === 'cd' || program === 'echo' || program === 'true') return true;
  if (!program || !FILTERS.has(program)) return false;
  // Options alone: `-n 40`, `-3`, `-c`, `-rn`; a `grep` also has its pattern.
  const plain = (a: string) => /^-[A-Za-z]+$/.test(a) || /^-?\d+$/.test(a);
  // `sort -o` writes its output to a file.
  if (program === 'sort' && args.some((a) => /^-[A-Za-z]*o/.test(a))) return false;
  if (program !== 'grep') return args.every(plain);
  // A long option can name a file to read (`--file=…`) or a folder to walk.
  if (args.some((a) => a.startsWith('--'))) return false;
  const operands = args.filter((a) => !/^-[A-Za-z]+$/.test(a));
  return operands.length === 1 && !args.some((a) => /^-[A-Za-z]*[fr]/i.test(a));
}
