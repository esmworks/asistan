import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUpdates, type Updater, type Updates } from './updates';

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  checkForUpdates() {
    this.checks++;
    return Promise.resolve(null);
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('masaüstü güncellemeleri', () => {
  let updater: FakeUpdater;
  let updates: Updates | null = null;
  const steps: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    updater = new FakeUpdater();
    steps.length = 0;
  });
  afterEach(() => {
    updates?.stop();
    vi.useRealTimers();
  });

  function start(answer: boolean) {
    updates = startUpdates({
      updater,
      everyMs: 1000,
      ask: async (version) => {
        steps.push(`ask ${version}`);
        return answer;
      },
      beforeInstall: async () => {
        steps.push('server stopped');
      },
      onReady: (version) => steps.push(`ready ${version}`),
      warn: (message) => steps.push(message),
    });
    return updates;
  }

  it('açılışta ve aralıklarla arar, indirilen sürümü kapanışta yükler', () => {
    start(false);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checks).toBe(1);
    vi.advanceTimersByTime(2500);
    expect(updater.checks).toBe(3);
  });

  it('kabul edilirse önce sunucuyu durdurur, sonra sessizce yükleyip yeniden açar', async () => {
    start(true);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'ask 0.2.1', 'server stopped']);
    expect(updater.installs).toEqual([[true, true]]);
  });

  it('sonraya bırakılırsa bir daha sormaz ve aramayı keser; menüden yüklenebilir', async () => {
    const { install } = start(false);
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    updater.emit('update-downloaded', { version: '0.2.1' });
    vi.advanceTimersByTime(5000);
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'ask 0.2.1']);
    expect(updater.checks).toBe(1);
    expect(updater.installs).toEqual([]);

    await install();
    await install();
    expect(updater.installs).toEqual([[true, true]]);
  });

  it('indirilmiş sürüm yokken yüklemez; arama hatasını günlüğe yazar', async () => {
    const { install } = start(true);
    await install();
    expect(updater.installs).toEqual([]);
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(steps).toEqual(['update check failed: net::ERR_INTERNET_DISCONNECTED']);
  });

  it('keeps the version waiting when the person declines to restart while bots work', async () => {
    let allow = false;
    updates = startUpdates({
      updater,
      everyMs: 1000,
      ask: async () => true,
      confirmInstall: async () => {
        steps.push('confirm');
        return allow;
      },
      beforeInstall: async () => {
        steps.push('server stopped');
      },
      onReady: (version) => steps.push(`ready ${version}`),
      warn: (message) => steps.push(message),
    });
    updater.emit('update-downloaded', { version: '0.2.1' });
    await flush();
    expect(steps).toEqual(['ready 0.2.1', 'confirm']);
    expect(updater.installs).toEqual([]);

    allow = true;
    await updates.install();
    expect(steps).toEqual(['ready 0.2.1', 'confirm', 'confirm', 'server stopped']);
    expect(updater.installs).toEqual([[true, true]]);
  });
});
