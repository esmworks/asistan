import { describe, expect, it } from 'vitest';
import { translator } from '../i18n';
import {
  formatMessages,
  formatRequests,
  MASK,
  MAX_REQUESTS,
  PageLog,
  requestFailed,
  safeText,
  safeUrl,
} from './logs';

const t = translator('en');

describe('safeUrl', () => {
  it('hides parameters that may carry a secret and keeps the rest readable', () => {
    const url = safeUrl(
      'https://user:pw@api.example.com/v1/items?q=chairs&access_token=abc123&apiKey=k&code=xyz&page=2&sessionId=s#id_token=t',
    );
    expect(url).toBe(
      `https://api.example.com/v1/items?q=chairs&access_token=${MASK}&apiKey=${MASK}&code=${MASK}&page=2&sessionId=${MASK}`,
    );
    // A name that only contains a short secret word is left alone.
    expect(safeUrl('https://example.com/search?keyword=desk&country_code=TR')).toBe(
      'https://example.com/search?keyword=desk&country_code=TR',
    );
  });

  it('cuts addresses that carry their whole content', () => {
    const data = `data:image/png;base64,${'A'.repeat(5000)}`;
    expect(safeUrl(data).length).toBeLessThan(80);
    expect(safeUrl(`https://example.com/${'x'.repeat(1000)}`).length).toBeLessThan(400);
  });
});

describe('safeText', () => {
  it('hides tokens a script prints and makes the addresses in it safe', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXBhcnQ';
    const out = safeText(`token ${jwt} sent with Bearer abcdefghij12 to https://a.example.com/x?token=zzz`);
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('abcdefghij12');
    expect(out).not.toContain('zzz');
    expect(out).toContain(`Bearer ${MASK}`);
    expect(safeText('x'.repeat(5000)).length).toBeLessThan(1100);
  });
});

describe('PageLog', () => {
  it('keeps the latest entries and counts what it let go', () => {
    const log = new PageLog();
    for (let i = 0; i < MAX_REQUESTS + 5; i++) {
      log.addRequest({
        method: 'GET',
        url: `https://e.com/${i}`,
        type: 'fetch',
        status: 200,
        failure: null,
        ms: 1,
      });
    }
    expect(log.requests).toHaveLength(MAX_REQUESTS);
    expect(log.droppedRequests).toBe(5);
    expect(log.requests[0]!.url).toBe('https://e.com/5');
    log.clearRequests();
    expect(log.requests).toEqual([]);
    expect(log.droppedRequests).toBe(0);
    // Numbers go on after a clear, so an earlier reply's numbers never name another entry.
    expect(
      log.addRequest({ method: 'GET', url: 'u', type: 'xhr', status: null, failure: null, ms: null }).id,
    ).toBe(MAX_REQUESTS + 6);
  });
});

describe('formatting', () => {
  it('writes one line per request with what went wrong', () => {
    const base = { method: 'GET', type: 'fetch', ms: 12 };
    const lines = formatRequests(
      [
        { id: 1, ...base, url: 'https://e.com/ok', status: 200, failure: null },
        { id: 2, ...base, url: 'https://e.com/err', status: 500, failure: null },
        { id: 3, ...base, url: 'https://e.com/down', status: null, failure: 'net::ERR_CONNECTION_REFUSED' },
        { id: 4, ...base, url: 'http://127.0.0.1/', status: null, failure: 'net::ERR_BLOCKED_BY_CLIENT' },
        { id: 5, ...base, url: 'https://e.com/slow', status: null, failure: null, ms: null },
      ],
      t,
    ).split('\n');
    expect(lines[0]).toBe('#1 GET 200 fetch 12 ms https://e.com/ok');
    expect(lines[1]).toBe('#2 GET 500 fetch 12 ms https://e.com/err');
    expect(lines[2]).toContain('failed (net::ERR_CONNECTION_REFUSED)');
    expect(lines[3]).toContain('refused (this computer or the local network)');
    expect(lines[4]).toBe('#5 GET waiting fetch https://e.com/slow');
    expect(requestFailed({ id: 1, ...base, url: '', status: 404, failure: null })).toBe(true);
    expect(requestFailed({ id: 1, ...base, url: '', status: 302, failure: null })).toBe(false);
  });

  it('writes one line per console message, an uncaught error named as such', () => {
    const out = formatMessages(
      [
        { id: 7, level: 'warning', text: 'old API', where: 'https://e.com/app.js:3', uncaught: false },
        { id: 8, level: 'error', text: 'TypeError: x is undefined', where: null, uncaught: true },
      ],
      t,
    );
    expect(out).toBe(
      '#7 [warning] old API (https://e.com/app.js:3)\n#8 [uncaught error] TypeError: x is undefined',
    );
  });
});
