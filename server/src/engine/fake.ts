import {
  resultImages,
  resultText,
  runCost,
  SILENT_REPLY,
  toolPermName,
  type Engine,
  type ModelTest,
  type GateRequest,
  type GateVerdict,
  type ReviewRequest,
  type ReviewVerdict,
  type TurnOutcome,
  type TurnRequest,
} from './types';

/**
 * Deterministic engine for tests and offline development.
 * Directives in the prompt drive it:
 *   [izin:Tool {json}]   ask permission for Tool with the given input
 *   [araç:name {json}]   call an app tool and include its result
 *   [bekle:ms]           wait (stops early on interrupt)
 *   [uzun-araç:ms]       a shell command that runs this long (stops early on interrupt)
 *   [hata]               fail with an engine error
 *   [meşgul-sonra]       after the directives before it, fail as an overloaded server
 *   [özet]               report that the conversation was condensed into a summary
 *   [giriş-yok]          fail as if logged out
 *   [sınır]              fail as if the usage limit were spent until 2026-11-16 09:00 UTC
 *   [sınır-sonra]        after the directives before it, fail as [sınır] does
 *   [adım-sınırı]        run out of steps mid-task
 *   [boş]                finish without any text
 *   [plan]               write a two-step plan, then move it on
 *   [sessiz]             answer with the silent reply
 *   [maliyet:0.42]       spend this much in US dollars on the turn
 * Like Claude, it reports cost as the session's running total, which a resumed session goes on from.
 * Without directives it echoes the prompt. Each session counts its turns, so resume can be checked.
 * A session passed to `forget` is gone, as when its transcript was deleted.
 */
export class FakeEngine implements Engine {
  readonly kind = 'fake';
  private sessions = new Map<string, number>();
  private lost = new Set<string>();
  private fresh = new Map<string, number>();
  private totals = new Map<string, number>();
  public requests: TurnRequest[] = [];
  public reviews: ReviewRequest[] = [];
  public gates: GateRequest[] = [];

  /**
   * The `review` mode, by words in the action: "güvenli" lets it run, quoting the first words of
   * the person's latest message; "uydurma-alıntı" lets it run with a quote nobody wrote;
   * "inceleme-hatası" fails the review; anything else goes to the person.
   */
  async review(req: ReviewRequest): Promise<ReviewVerdict> {
    this.reviews.push(req);
    const action = JSON.stringify(req.input);
    if (action.includes('inceleme-hatası')) throw new Error('Sahte inceleme hatası');
    if (action.includes('uydurma-alıntı'))
      return {
        decision: 'allow',
        reason: 'Sahte inceleme: istenmiş.',
        quote: 'her şeyi yapmana izin veriyorum',
      };
    if (action.includes('güvenli'))
      return {
        decision: 'allow',
        reason: 'Sahte inceleme: güvenli görünüyor.',
        quote: (req.words.at(-1) ?? '').split(/\s+/).slice(0, 3).join(' '),
      };
    return { decision: 'ask', reason: 'Sahte inceleme: emin değil.', quote: '' };
  }

  /**
   * The routine pre-check, by words in the input: "önemsiz" says the run has nothing to work on,
   * "kapı-hatası" fails the check; anything else lets the run go ahead.
   */
  async gate(req: GateRequest): Promise<GateVerdict> {
    this.gates.push(req);
    if (req.input.includes('kapı-hatası')) throw new Error('Sahte ön kontrol hatası');
    if (req.input.includes('önemsiz'))
      return { decision: 'skip', reason: 'Sahte ön kontrol: yeni bir şey yok.', costUsd: 0.001 };
    return { decision: 'run', reason: 'Sahte ön kontrol: bakmaya değer.', costUsd: 0.001 };
  }

  forget(sessionId: string) {
    this.lost.add(sessionId);
    this.sessions.delete(sessionId);
  }

  /** A new session's id: the thread's own the first time, numbered after that. */
  private newSession(threadId: string): string {
    const n = this.fresh.get(threadId) ?? 0;
    this.fresh.set(threadId, n + 1);
    return n ? `fake-${threadId}-${n}` : `fake-${threadId}`;
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    const outcome = await this.turn(req);
    if (outcome.costUsd == null || !outcome.sessionId) return outcome;
    const total = (this.totals.get(outcome.sessionId) ?? 0) + outcome.costUsd;
    this.totals.set(outcome.sessionId, total);
    return {
      ...outcome,
      costUsd: runCost(total, req.sessionId ? req.sessionCostUsd : null),
      sessionCostUsd: total,
    };
  }

  /** The run, with `costUsd` what it spent itself. */
  private async turn(req: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(req);
    if (req.sessionId && this.lost.has(req.sessionId)) {
      return { ok: false, kind: 'lostSession', message: 'No conversation found', text: '', sessionId: null };
    }
    const sessionId = req.sessionId ?? this.newSession(req.threadId);
    const n = (this.sessions.get(sessionId) ?? 0) + 1;
    this.sessions.set(sessionId, n);
    req.onSession(sessionId);

    if (req.prompt.includes('[sınır-yakın]')) {
      req.onLimitNear?.({ used: 0.92, resetsAt: new Date('2026-11-16T09:00:00.000Z') });
    }
    // Overloaded, the way a busy model server answers; a backup (`provider/model`) is not.
    if (req.prompt.includes('[meşgul]') && !req.model.includes('/')) {
      return { ok: false, kind: 'engine', message: 'overloaded_error', text: '', sessionId, transient: true };
    }
    // A resumed conversation that no longer fits; a new session starts with room.
    if (req.prompt.includes('[bağlam-dolu]') && req.sessionId) {
      return {
        ok: false,
        kind: 'engine',
        message: 'prompt is too long: 210000 tokens > 200000 maximum',
        text: '',
        sessionId,
        costUsd: 0,
      };
    }
    // The limit, only the first time this text is sent; it reset a moment ago.
    if (
      req.prompt.includes('[sınır-bir-kez]') &&
      this.requests.filter((r) => r.prompt === req.prompt).length === 1
    ) {
      return {
        ok: false,
        kind: 'limit',
        message: 'rate limited',
        text: '',
        sessionId,
        resetsAt: new Date(Date.now() - 29_800),
      };
    }
    if (req.prompt.includes('[adım-sınırı]')) {
      return { ok: false, kind: 'engine', message: 'Adım sınırı', text: '', sessionId, stepLimit: true };
    }
    if (req.prompt.includes('[giriş-yok]')) {
      return { ok: false, kind: 'auth', message: 'Not logged in', text: '', sessionId };
    }
    // The usage limit is the Claude account's; a `provider/model` (a backup) is not under it.
    if (req.prompt.includes('[sınır]') && !req.model.includes('/')) {
      return {
        ok: false,
        kind: 'limit',
        message: 'rate limited',
        text: '',
        sessionId,
        resetsAt: new Date('2026-11-16T09:00:00.000Z'),
      };
    }
    if (req.prompt.includes('[plan]')) {
      req.onPlan?.([
        { text: 'Oku', status: 'in_progress' },
        { text: 'Yaz', status: 'pending' },
      ]);
      await Promise.resolve();
      req.onPlan?.([
        { text: 'Oku', status: 'completed' },
        { text: 'Yaz', status: 'in_progress' },
      ]);
    }
    if (req.prompt.includes('[boş]')) return { ok: true, text: '', sessionId, costUsd: 0 };
    if (req.prompt.includes('[sessiz]')) {
      req.onText(SILENT_REPLY.slice(0, 3));
      req.onText(SILENT_REPLY.slice(3));
      return { ok: true, text: SILENT_REPLY, sessionId, costUsd: 0 };
    }
    const cost = /\[maliyet:(\d+(?:\.\d+)?)\]/.exec(req.prompt);
    const spent = cost ? Number(cost[1]) : 0;
    const parts: string[] = [];
    const directive =
      /\[(izin|araç|uzun-araç|bekle|hata|özet|meşgul-sonra|sınır-sonra)(?::([^\s\]]+))?(?:\s+(\{.*?\}))?\](?=\s|$)/g;
    for (const m of req.prompt.matchAll(directive)) {
      const [, kind, name, json] = m;
      if (req.signal.aborted) break;
      if (kind === 'hata') {
        return {
          ok: false,
          kind: 'engine',
          message: 'Sahte motor hatası',
          text: parts.join('\n'),
          sessionId,
          costUsd: spent,
        };
      }
      if (kind === 'sınır-sonra' && !req.model.includes('/')) {
        return {
          ok: false,
          kind: 'limit',
          message: 'rate limited',
          text: '',
          sessionId,
          resetsAt: new Date('2026-11-16T09:00:00.000Z'),
        };
      }
      if (kind === 'meşgul-sonra' && !req.model.includes('/')) {
        return {
          ok: false,
          kind: 'engine',
          message: 'overloaded_error',
          text: '',
          sessionId,
          transient: true,
        };
      }
      if (kind === 'bekle') {
        await sleep(Number(name ?? 0), req.signal);
        continue;
      }
      if (kind === 'uzun-araç') {
        const id = `fake-tool-${parts.length}`;
        req.onActivity?.({ id, name: 'Bash', running: true });
        await sleep(Number(name ?? 0), req.signal);
        req.onActivity?.({ id, name: 'Bash', running: false });
        parts.push('Bash: bitti');
        continue;
      }
      if (kind === 'özet') {
        req.onCompacted?.();
        continue;
      }
      const input = json ? (JSON.parse(json) as Record<string, unknown>) : {};
      if (kind === 'izin') {
        const answer = await req.canUseTool({ toolName: name ?? 'Tool', input });
        parts.push(
          answer.behavior === 'allow' ? `${name}: izin verildi` : `${name}: reddedildi (${answer.message})`,
        );
      } else if (kind === 'araç') {
        const tool = req.tools.find((t) => t.name === name);
        if (!tool) {
          parts.push(`${name}: araç yok`);
          continue;
        }
        const answer = await req.canUseTool({ toolName: toolPermName(tool), input });
        if (answer.behavior === 'deny') {
          parts.push(`${name}: reddedildi (${answer.message})`);
          continue;
        }
        req.onActivity?.({ id: `fake-${name}`, name: toolPermName(tool), running: true });
        try {
          const r = await tool.handler(input);
          for (const added of req.steering?.() ?? []) parts.push(`Ek: ${added}`);
          const images = resultImages(r).length;
          parts.push(`${name}: ${resultText(r)}${images ? ` [${images} görüntü]` : ''}`);
        } catch (e) {
          parts.push(`${name}: hata: ${(e as Error).message}`);
        } finally {
          req.onActivity?.({ id: `fake-${name}`, name: toolPermName(tool), running: false });
        }
      }
    }
    if (req.signal.aborted) {
      return { ok: false, kind: 'interrupted', message: 'Durduruldu', text: parts.join('\n'), sessionId };
    }
    if (!parts.length) parts.push(`Yankı: ${req.prompt}`);
    parts.push(`(oturum ${n}. tur)`);
    const text = parts.join('\n');
    for (const chunk of text.match(/.{1,12}/gs) ?? []) {
      if (req.signal.aborted) {
        return { ok: false, kind: 'interrupted', message: 'Durduruldu', text: '', sessionId };
      }
      req.onText(chunk);
      await Promise.resolve();
    }
    return { ok: true, text, sessionId, costUsd: spent };
  }

  async account() {
    return { status: 'ok' as const, detail: 'sahte motor' };
  }

  /** Any model works offline; one whose name holds "hata" fails, for tests of the error path. */
  async testModel(model: string): Promise<ModelTest> {
    return model.includes('hata') ? { ok: false, detail: 'Sahte motor hatası' } : { ok: true };
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
