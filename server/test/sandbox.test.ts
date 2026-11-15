import { describe, expect, it } from 'vitest';
import { sandboxOptions } from '../src/engine/claude';
import { probeShellSandbox } from '../src/shell-sandbox';

describe('Bash yalıtımı', () => {
  const sb = {
    cwd: '/veri/workspaces/bots/a/threads/t',
    additionalDirectories: ['/veri/workspaces/bots/a/files'],
    writable: ['/veri/workspaces/bots/a/threads/t'],
    internet: true,
    readOnly: false,
  };

  it('ev, veri ve Claude giriş klasörlerini okumaya kapatır, botun kendi klasörlerini açar', () => {
    const o = sandboxOptions(sb, ['/home/u', '/veri', '/veri/claude', '/veri']);
    expect(o.sandbox?.filesystem?.denyRead).toEqual(['/home/u', '/veri', '/veri/claude']);
    expect(o.sandbox?.filesystem?.allowRead).toEqual([sb.cwd, ...sb.additionalDirectories]);
    expect(o.sandbox?.failIfUnavailable).toBe(true);
    expect(o.sandbox?.allowUnsandboxedCommands).toBe(false);
  });

  it('macOS yalıtımı her zaman var sayar, desteklenmeyen sistemde çalışmıyor der', async () => {
    expect(await probeShellSandbox('darwin')).toEqual({ status: 'ok', detail: null });
    expect((await probeShellSandbox('win32')).status).toBe('unavailable');
  });
});
