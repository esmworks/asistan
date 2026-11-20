import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LinkPreviews, githubPreview, pagePreview, previewable } from '../src/services/link-preview';
import type { PublicFetchOptions, PublicResponse } from '../src/services/skill-link';
import { testServer, type TestServer } from './helpers';

const page = (html: string, type = 'text/html; charset=utf-8') => ({ html, type });

function fakeFetch(pages: Record<string, { html: string; type: string }>) {
  const asked: { url: string; o: PublicFetchOptions }[] = [];
  const fetch = async (url: URL, _max: number, o: PublicFetchOptions = {}): Promise<PublicResponse> => {
    asked.push({ url: url.href, o });
    const p = pages[url.href];
    if (!p) throw new Error('unreachable');
    return { body: Buffer.from(p.html), contentType: p.type, url };
  };
  return { fetch, asked };
}

describe('link previews', () => {
  it("reads a page's social tags before its title, and decodes what they hold", () => {
    const p = pagePreview(
      `<html><head><title>Plain</title>
       <meta property="og:title" content="Rapor &amp; analiz">
       <meta name="description" content='Kısa &#x131;zah'>
       <meta property="og:site_name" content="Örnek"></head><body><meta name="description" content="body"></body>`,
      new URL('https://www.example.com/a'),
    );
    expect(p).toEqual({
      url: 'https://www.example.com/a',
      site: 'Örnek',
      title: 'Rapor & analiz',
      description: 'Kısa ızah',
    });
    expect(pagePreview('<html><head></head></html>', new URL('https://x.com'))).toBeNull();
    expect(pagePreview('<title>Yalnız başlık</title>', new URL('https://www.x.com'))?.site).toBe('x.com');
  });

  it('names a pull request or issue by its state', () => {
    const url = new URL('https://github.com/o/r/pull/7');
    const pr = (extra: object) =>
      githubPreview(
        { number: 7, title: 'Fix', state: 'open', user: { login: 'ali' }, ...extra },
        url,
        'o/r',
        'pr',
      )?.github?.state;
    expect(pr({})).toBe('open');
    expect(pr({ draft: true })).toBe('draft');
    expect(pr({ state: 'closed', merged_at: '2026-01-01' })).toBe('merged');
    expect(pr({ state: 'closed', merged_at: null })).toBe('closed');
    const issue = (extra: object) =>
      githubPreview({ number: 3, title: 'Bug', state: 'closed', ...extra }, url, 'o/r', 'issue')?.github;
    expect(issue({ state_reason: 'not_planned' })?.state).toBe('notPlanned');
    expect(issue({ pull_request: {} })?.kind).toBe('pr');
    expect(githubPreview({}, url, 'o/r', 'pr')).toBeNull();
  });

  it('asks GitHub for a pull request, reads a page once over https, and keeps what it found', async () => {
    let now = 0;
    const { fetch, asked } = fakeFetch({
      'https://api.github.com/repos/o/r/pulls/12': page(
        JSON.stringify({ number: 12, title: 'Add it', state: 'open', draft: false, user: { login: 'ayse' } }),
        'application/json',
      ),
      'https://example.com/post': page('<title>Yazı</title>'),
    });
    const previews = new LinkPreviews(fetch, () => now);
    expect(await previews.get('https://github.com/o/r/pull/12/files')).toMatchObject({
      title: 'Add it',
      github: { kind: 'pr', repo: 'o/r', number: 12, state: 'open', author: 'ayse' },
    });
    expect(await previews.get('http://example.com/post#top')).toMatchObject({ title: 'Yazı' });
    await previews.get('https://example.com/post');
    expect(asked.map((a) => a.url)).toEqual([
      'https://api.github.com/repos/o/r/pulls/12',
      'https://example.com/post',
    ]);
    // Only the start of a page is read.
    expect(asked[1]!.o.start).toBe(true);
    now += 11 * 60_000;
    await previews.get('https://example.com/post');
    expect(asked).toHaveLength(3);
  });

  it('does not read a link that carries a key, a token or a long code, and leaves out the query', async () => {
    const u = (s: string) => new URL(s);
    expect(previewable(u('https://example.com/blog/how-to-bake-bread-2026'))).toBe(true);
    expect(previewable(u('https://evil.example/x?k=sk-ant-api03-' + 'a'.repeat(90)))).toBe(false);
    expect(previewable(u('https://evil.example/c/cnry-0123456789abcdef01234567'))).toBe(false);
    expect(previewable(u('https://evil.example/c/aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA1'))).toBe(false);
    expect(previewable(u('https://evil.example/' + 'a/'.repeat(200)))).toBe(false);

    const { fetch, asked } = fakeFetch({ 'https://example.com/search': page('<title>Arama</title>') });
    const previews = new LinkPreviews(fetch);
    expect(await previews.get('https://example.com/search?q=gizli+not&session=abc')).toMatchObject({
      title: 'Arama',
    });
    expect(asked.map((a) => a.url)).toEqual(['https://example.com/search']);
  });

  it('gives nothing for what is not a web page, cannot be reached or is not a link', async () => {
    const { fetch } = fakeFetch({ 'https://example.com/file.pdf': page('%PDF', 'application/pdf') });
    const previews = new LinkPreviews(fetch);
    expect(await previews.get('https://example.com/file.pdf')).toBeNull();
    expect(await previews.get('https://nowhere.example/')).toBeNull();
    expect(await previews.get('mailto:a@b.c')).toBeNull();
    expect(await previews.get('not a url')).toBeNull();
  });
});

describe('link preview route', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('refuses a private address and answers with no preview', async () => {
    const res = await t.api<{ preview: unknown }>(
      'GET',
      `/api/link-preview?url=${encodeURIComponent('https://127.0.0.1/admin')}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.preview).toBeNull();
  });
});
