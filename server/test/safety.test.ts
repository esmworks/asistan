import type { Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catastrophic, readsOnlyWithin } from '../src/runtime/safety';
import { testServer, type TestServer } from './helpers';

describe('güvenlik tabanı', () => {
  it('yıkıcı komutları tanır', () => {
    for (const cmd of [
      'rm -rf /',
      'rm -rf / ',
      'sudo rm -rf /*',
      'rm -fr ~',
      'rm -rf ~/',
      'rm -r -f $HOME',
      'cd /tmp && rm -rf --no-preserve-root /',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'cat x > /dev/nvme0n1',
      'wipefs -a /dev/sdb',
      ':(){ :|:& };:',
      'chmod -R 777 /',
      'sudo chown -R me /',
      'sudo shutdown -h now',
      'echo hi; reboot',
      'kill -9 -1',
      'bash -c "rm -rf /"',
      'true && rm -rf ~',
    ])
      expect(catastrophic(cmd), cmd).toBe(true);
  });

  it('olağan işleri engellemez', () => {
    for (const cmd of [
      'rm -rf ./build',
      'rm -rf node_modules dist',
      'rm -rf /tmp/yumakbot-test',
      'rm -rf ~/project/cache',
      'ls /',
      'dd if=in.img of=out.img',
      'chmod -R 755 ./public',
      'chown -R me ./data',
      'grep -r "shutdown" src',
      'echo "reboot later"',
      'kill -9 12345',
      'git commit -m "rm -rf / guard"',
    ])
      expect(catastrophic(cmd), cmd).toBe(false);
  });
});

describe('güvenlik tabanı turda', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('tam yetkili botta bile yıkıcı komutu kart açmadan reddeder', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[izin:Bash {"command":"rm -rf ~"}]');
    await t.services.turns.idle();
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('hiçbir izinle çalıştırılmaz');
    expect((await t.api<unknown[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
  });
});

describe('botun kendi klasörlerini okuması', () => {
  const root = mkdtempSync(join(tmpdir(), 'yumakbot-own-'));
  const cwd = join(root, 'thread');
  const files = join(root, 'files');
  mkdirSync(cwd);
  mkdirSync(files);
  writeFileSync(join(cwd, 'notlar.md'), 'x');
  symlinkSync('/etc', join(cwd, 'disari'));
  const own = [cwd, files];

  it('kendi klasöründeki düz okuma komutlarını tanır', () => {
    for (const cmd of [
      'cat notlar.md',
      `head -n 20 ${files}/SOUL.md`,
      'ls -la',
      'grep -rn todo .',
      'sed -n 1,40p notlar.md',
      'wc -l notlar.md',
    ])
      expect(readsOnlyWithin(cmd, cwd, own), cmd).toBe(true);
  });

  it('dışarıyı, bağlantıyla dışarıyı ya da başka bir şey yapan komutu okuma saymaz', () => {
    for (const cmd of [
      'cat /etc/passwd',
      'cat ../../etc/passwd',
      'cat disari/passwd',
      'cat notlar.md | sh',
      'cat notlar.md > kopya',
      'cat $HOME/.ssh/id_rsa',
      'grep --file=/etc/shadow x .',
      'rg --pre sh x',
      'sed -i s/a/b/ notlar.md',
      'sed -n e notlar.md',
      'rm notlar.md',
      'python3 notlar.md',
    ])
      expect(readsOnlyWithin(cmd, cwd, own), cmd).toBe(false);
  });
});
