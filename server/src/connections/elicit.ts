/**
 * An MCP server may ask the person for a few values in the middle of a tool call (elicitation).
 * The fields it asks for become questions on a card in the chat; the answers go back typed as
 * the server described them.
 */

/** One field of the form a server asks for, as the protocol describes it. */
interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: unknown[];
  oneOf?: { const?: unknown; title?: unknown }[];
  anyOf?: { const?: unknown; title?: unknown }[];
  items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: unknown }[] };
  default?: unknown;
}

export interface ElicitForm {
  message: string;
  requestedSchema: { properties: Record<string, unknown>; required?: string[] };
}

/** A question on the card and how to read its answer back. */
export interface ElicitQuestion {
  key: string;
  question: string;
  /** Choices shown on the card, by label. */
  options: string[];
  /** Label → value sent back; empty for free text. */
  values: Map<string, string>;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'multi';
  required: boolean;
}

export type ElicitContent = Record<string, string | number | boolean | string[]>;

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** The card's questions for a form; `yesNo` are the labels for a yes/no field. */
export function elicitQuestions(form: ElicitForm, yesNo: [string, string]): ElicitQuestion[] {
  const required = new Set(form.requestedSchema.required ?? []);
  return Object.entries(form.requestedSchema.properties)
    .slice(0, 6)
    .map(([key, raw]) => {
      const f = (raw ?? {}) as FieldSchema;
      const label = f.title || key;
      const question = f.description ? `${label} — ${f.description}` : label;
      const values = new Map<string, string>();
      const choices = (list: { const?: unknown; title?: unknown }[]) => {
        for (const c of list) values.set(str(c.title) || str(c.const), str(c.const));
      };
      let kind: ElicitQuestion['kind'] = 'string';
      if (f.type === 'array') {
        kind = 'multi';
        if (f.items?.anyOf) choices(f.items.anyOf);
        else for (const v of f.items?.enum ?? []) values.set(str(v), str(v));
      } else if (f.type === 'boolean') {
        kind = 'boolean';
        values.set(yesNo[0], 'true');
        values.set(yesNo[1], 'false');
      } else if (f.type === 'number' || f.type === 'integer') {
        kind = f.type;
      } else if (f.oneOf || f.anyOf) {
        choices((f.oneOf ?? f.anyOf)!);
      } else if (f.enum) {
        f.enum.forEach((v, i) => values.set(str(f.enumNames?.[i]) || str(v), str(v)));
      }
      return {
        key,
        question: question.slice(0, 500),
        options: [...values.keys()].slice(0, 8),
        values,
        kind,
        required: required.has(key),
      };
    });
}

/**
 * The answers as the content the server asked for, or null when a required one is missing or an
 * answer is not of its kind (the request is then declined).
 */
export function elicitContent(questions: ElicitQuestion[], answers: string[]): ElicitContent | null {
  const content: ElicitContent = {};
  for (const [i, q] of questions.entries()) {
    const raw = (answers[i] ?? '').trim();
    if (!raw) {
      if (q.required) return null;
      continue;
    }
    const pick = (label: string) => q.values.get(label) ?? label;
    switch (q.kind) {
      case 'boolean': {
        const v = pick(raw);
        if (v !== 'true' && v !== 'false') return null;
        content[q.key] = v === 'true';
        break;
      }
      case 'number':
      case 'integer': {
        const n = Number(raw.replace(',', '.'));
        if (!Number.isFinite(n) || (q.kind === 'integer' && !Number.isInteger(n))) return null;
        content[q.key] = n;
        break;
      }
      case 'multi':
        content[q.key] = raw
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map(pick);
        break;
      default:
        content[q.key] = pick(raw);
    }
  }
  return content;
}
