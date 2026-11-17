import { randomBytes, scryptSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, PASSWORD_SCRYPT } from '../src/account';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('hesap şifresinin özeti', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const stored = async () =>
    (await t.services.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'account')))[0]!.value as {
      salt: string;
      hash: string;
      N: number;
      r: number;
      p: number;
    };

  it('yeni özet yüksek maliyetle yapılır', async () => {
    const account = new Account(t.services.ctx.db);
    await account.set('erhan', 'gizli-sifre');
    expect(await stored()).toMatchObject(PASSWORD_SCRYPT);
    expect(PASSWORD_SCRYPT.N).toBeGreaterThanOrEqual(2 ** 17);
    expect(await account.check('gizli-sifre', 'erhan')).toBe(true);
  });

  it('eski düşük maliyetli özet doğrulanır ve doğru girişte yenisiyle değiştirilir', async () => {
    const salt = randomBytes(16);
    const old = { N: 16384, r: 8, p: 1 };
    const value = {
      username: 'erhan',
      salt: salt.toString('base64'),
      hash: scryptSync('eski-sifre'.normalize('NFKC'), salt, 64, old).toString('base64'),
      ...old,
    };
    await t.services.ctx.db
      .insert(schema.kv)
      .values({ key: 'account', value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
    const account = new Account(t.services.ctx.db);

    // A wrong password leaves the old hash as it is.
    expect(await account.check('yanlis-sifre', 'erhan')).toBe(false);
    expect(await stored()).toMatchObject(old);
    // The right password but another username is not a sign-in either.
    expect(await account.check('eski-sifre', 'baska')).toBe(false);
    expect(await stored()).toMatchObject(old);

    expect(await account.check('eski-sifre', 'erhan')).toBe(true);
    const now = await stored();
    expect(now).toMatchObject(PASSWORD_SCRYPT);
    expect(now.hash).not.toBe(value.hash);
    expect(await account.check('eski-sifre', 'erhan')).toBe(true);
    expect(await account.check('yanlis-sifre', 'erhan')).toBe(false);
  });

  it('karşılanamayacak maliyet isteyen özeti kabul etmez', async () => {
    const value = { username: 'erhan', salt: 'AAAA', hash: 'AAAA', N: 2 ** 30, r: 8, p: 1 };
    await t.services.ctx.db
      .insert(schema.kv)
      .values({ key: 'account', value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
    expect(await new Account(t.services.ctx.db).check('herhangi', 'erhan')).toBe(false);
  });
});
