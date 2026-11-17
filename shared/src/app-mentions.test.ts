import { describe, expect, it } from 'vitest';
import { mentionedApps, missingApps } from './app-mentions';

const ids = (text: string) => mentionedApps(text).map((e) => e.id);

describe('mentionedApps', () => {
  it('finds the apps an instruction names', () => {
    expect(ids("Her sabah Notion'daki görevleri oku ve Linear'a yaz")).toEqual(['linear', 'notion']);
    expect(ids('Check Jira for new bugs')).toEqual(['atlassian']);
    expect(ids('post it on wordpress.com and WordPress')).toEqual(['wordpress-com']);
  });

  it('matches a distinctive name in any case, a plain word only as written', () => {
    expect(ids('google docs ve CLICKUP')).toEqual(['clickup', 'google-docs']);
    expect(ids('a notion of linear growth')).toEqual([]);
  });

  it('does not take everyday words or parts of words for apps', () => {
    expect(ids('Close the tab. Make a list. Box it up.')).toEqual([]);
    expect(ids('Notionally speaking')).toEqual([]);
    expect(ids('')).toEqual([]);
  });

  it('prefers the longer name of two that overlap', () => {
    expect(ids('Read the Cloudflare Docs')).toEqual(['cloudflare-docs']);
  });
});

describe('missingApps', () => {
  const notion = {
    catalogId: 'notion',
    url: 'https://mcp.notion.com/mcp',
    status: 'connected' as const,
    allBots: false,
    botIds: ['a'],
  };
  const text = 'Notion ve Linear';

  it('leaves out apps connected and open to the bot', () => {
    expect(missingApps(text, 'a', [notion]).map((e) => e.id)).toEqual(['linear']);
  });

  it('keeps apps open only to other bots, or not signed in', () => {
    expect(missingApps(text, 'b', [notion]).map((e) => e.id)).toEqual(['linear', 'notion']);
    expect(missingApps(text, 'a', [{ ...notion, status: 'signed-out' }]).map((e) => e.id)).toEqual([
      'linear',
      'notion',
    ]);
  });

  it('knows a connection added by address, and an API added under the app name', () => {
    const byUrl = { ...notion, catalogId: null, url: 'https://mcp.notion.com/mcp/' };
    const linearApi = { name: 'linear', title: 'Linear API', botIds: null };
    expect(missingApps(text, 'a', [byUrl], [linearApi])).toEqual([]);
  });
});
