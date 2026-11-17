import { randomBytes, scryptSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD_SCRYPT } from '../src/account';
import { schema } from '../src/db';
import type { PasswordHash } from '../src/db/schema';
import { OWNER_ID, Users } from '../src/users';
import { testServer, type TestServer } from './helpers';

describe('hesap şifresinin özeti', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const stored = async () =>
    (await t.services.ctx.db.select().from(schema.users).where(eq(schema.users.id, OWNER_ID)))[0]!.password!;
  const store = (password: PasswordHash) =>
    t.services.ctx.db
      .update(schema.users)
      .set({ username: 'erhan', usernameKey: 'erhan', password })
      .where(eq(schema.users.id, OWNER_ID));

  it('yeni özet yüksek maliyetle yapılır', async () => {
    const users = new Users(t.services.ctx.db);
    await users.setCredentials(OWNER_ID, 'erhan', 'gizli-sifre');
    expect(await stored()).toMatchObject(PASSWORD_SCRYPT);
    expect(PASSWORD_SCRYPT.N).toBeGreaterThanOrEqual(2 ** 17);
    expect((await users.check('erhan', 'gizli-sifre'))?.id).toBe(OWNER_ID);
  });

  it('eski düşük maliyetli özet doğrulanır ve doğru girişte yenisiyle değiştirilir', async () => {
    const salt = randomBytes(16);
    const old = { N: 16384, r: 8, p: 1 };
    const value = {
      salt: salt.toString('base64'),
      hash: scryptSync('eski-sifre'.normalize('NFKC'), salt, 64, old).toString('base64'),
      ...old,
    };
    await store(value);
    const users = new Users(t.services.ctx.db);

    // A wrong password leaves the old hash as it is.
    expect(await users.check('erhan', 'yanlis-sifre')).toBeNull();
    expect(await stored()).toMatchObject(old);
    // The right password but another username is not a sign-in either.
    expect(await users.check('baska', 'eski-sifre')).toBeNull();
    expect(await stored()).toMatchObject(old);

    expect(await users.check('erhan', 'eski-sifre')).not.toBeNull();
    const now = await stored();
    expect(now).toMatchObject(PASSWORD_SCRYPT);
    expect(now.hash).not.toBe(value.hash);
    expect(await users.check('erhan', 'eski-sifre')).not.toBeNull();
    expect(await users.check('erhan', 'yanlis-sifre')).toBeNull();
  });

  it('karşılanamayacak maliyet isteyen özeti kabul etmez', async () => {
    await store({ salt: 'AAAA', hash: 'AAAA', N: 2 ** 30, r: 8, p: 1 });
    expect(await new Users(t.services.ctx.db).check('erhan', 'herhangi')).toBeNull();
  });
});
