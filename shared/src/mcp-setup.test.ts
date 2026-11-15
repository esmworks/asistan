import { describe, expect, it } from 'vitest';
import { parseMcpSetup } from './mcp-setup';

describe('yapıştırılan MCP kurulumu', () => {
  it('düz adresi alır', () => {
    expect(parseMcpSetup(' https://mcp.notion.com/mcp ')).toEqual({ url: 'https://mcp.notion.com/mcp' });
  });

  it('komut satırından adı, adresi ve anahtarı çıkarır', () => {
    expect(parseMcpSetup('claude mcp add --transport http notion https://mcp.notion.com/mcp')).toEqual({
      name: 'notion',
      url: 'https://mcp.notion.com/mcp',
    });
    expect(
      parseMcpSetup(
        'claude mcp add linear --transport sse https://mcp.linear.app/sse --header "Authorization: Bearer abc123"',
      ),
    ).toEqual({ name: 'linear', url: 'https://mcp.linear.app/sse', token: 'abc123' });
    expect(parseMcpSetup('npx -y mcp-remote https://example.com/mcp')).toEqual({
      url: 'https://example.com/mcp',
    });
  });

  it('JSON yapılandırmasını okur', () => {
    expect(
      parseMcpSetup(
        JSON.stringify({
          mcpServers: {
            github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t0k' } },
          },
        }),
      ),
    ).toEqual({ name: 'github', url: 'https://api.githubcopilot.com/mcp/', token: 't0k' });
    expect(parseMcpSetup('{"servers":{"x":{"type":"http","url":"https://x.dev/mcp"}}}')).toEqual({
      name: 'x',
      url: 'https://x.dev/mcp',
    });
    expect(parseMcpSetup('{"type":"http","url":"https://y.dev/mcp"}')).toEqual({ url: 'https://y.dev/mcp' });
  });

  it('uzak sunucu adresi olmayanı geri çevirir', () => {
    expect(parseMcpSetup('npx -y @modelcontextprotocol/server-filesystem /tmp')).toBeNull();
    expect(parseMcpSetup('{"mcpServers":{"fs":{"command":"npx"}}}')).toBeNull();
    expect(parseMcpSetup('{bozuk')).toBeNull();
  });
});
