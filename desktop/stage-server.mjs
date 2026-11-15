// Puts the server with its production dependencies into .stage/server for packaging.
// The bundle keeps a few packages external (they load files next to themselves), so the
// packaged app needs a real node_modules beside it.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, '.stage', 'server');
// pnpm is a .cmd script on Windows, which only runs through a shell.
const shell = process.platform === 'win32';
const dist = join(root, 'server', 'dist', 'index.mjs');
if (!existsSync(dist)) throw new Error('Önce sunucuyu derleyin: pnpm --filter @yumakbot/server build');

rmSync(out, { recursive: true, force: true });
execFileSync('pnpm', ['--filter', '@yumakbot/server', 'deploy', '--prod', '--legacy', out], {
  cwd: root,
  stdio: 'inherit',
  shell,
});
// `deploy --prod` records the workspace install as production-only, after which pnpm wants
// to reinstall before every script. A frozen offline install puts the record back.
execFileSync('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: root, stdio: 'inherit', shell });
// Only the bundle runs; sources and tests are not shipped.
for (const extra of ['src', 'test', 'build.mjs', 'tsconfig.json', 'vitest.config.ts', 'drizzle.config.ts']) {
  rmSync(join(out, extra), { recursive: true, force: true });
}
// pnpm also links the server package itself into node_modules/.pnpm/node_modules, pointing back at
// server/ in the repository. Copied into the app, such a link points at nothing and packaging stops
// on it; only the bundle runs, so links that leave the stage are dropped.
// The listing also walks through linked folders, so it holds entries reached through a link that is
// removed here; those are gone with it and skipped.
const removed = [];
for (const entry of readdirSync(join(out, 'node_modules'), { recursive: true, withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const link = join(entry.parentPath, entry.name);
  if (removed.some((gone) => link.startsWith(gone + sep))) continue;
  const target = resolve(entry.parentPath, readlinkSync(link));
  if (relative(out, target).startsWith('..')) {
    rmSync(link);
    removed.push(link);
    console.log(`dışarıyı gösteren bağlantı kaldırıldı: ${relative(out, link)}`);
  }
}
// Type declarations and source maps are half of the files in node_modules and none of them run.
// Leaving them out keeps the app smaller and keeps macOS signing, which opens every file in the app
// at once, under the open-file limit.
const UNUSED = /\.(d\.[cm]?ts|map)$/;
let dropped = 0;
for (const entry of readdirSync(join(out, 'node_modules'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !UNUSED.test(entry.name)) continue;
  // Reached again through a link once it is gone.
  const file = join(entry.parentPath, entry.name);
  if (!existsSync(file)) continue;
  rmSync(file);
  dropped++;
}
console.log(`çalışmayan ${dropped} dosya (tip tanımı, kaynak eşlemesi) atıldı`);
cpSync(join(root, 'server', 'dist'), join(out, 'dist'), { recursive: true });
console.log(`sunucu hazır: ${out}`);
