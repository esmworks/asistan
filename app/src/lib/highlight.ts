import type { HighlighterCore, ThemedToken } from 'shiki/core';

/** Longer code is shown plain: colouring it would cost more than it helps. */
const MAX_CODE = 20_000;

let core: Promise<HighlighterCore> | null = null;

/**
 * The highlighter, made with the first code block that names a language. It runs on Shiki's
 * JavaScript regex engine, so it needs no WebAssembly and no change to the page's CSP.
 */
function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return core;
}

/**
 * The code's lines as coloured tokens, for the light and the dark theme at once (the dark colour
 * is in `--shiki-dark`); null for a language Shiki does not know, or code too long to colour.
 */
export async function highlight(code: string, language: string): Promise<ThemedToken[][] | null> {
  if (code.length > MAX_CODE) return null;
  const { bundledLanguages } = await import('shiki/langs');
  const id = language.toLowerCase() as keyof typeof bundledLanguages;
  const load = bundledLanguages[id];
  if (!load) return null;
  const h = await highlighter();
  if (!h.getLoadedLanguages().includes(id)) await h.loadLanguage(load);
  return h.codeToTokens(code, { lang: id, themes: { light: 'github-light', dark: 'github-dark' } }).tokens;
}
