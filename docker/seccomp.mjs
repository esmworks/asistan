// Writes docker/seccomp.json: Docker's default seccomp profile plus the five calls bubblewrap
// needs to build the Claude sandbox inside the container (user namespaces and its own mounts),
// and chroot, which Chromium's own sandbox uses inside a bot's desktop (Docker's default only
// allows it with CAP_SYS_CHROOT). Every other rule stays as in the default.  Run: node docker/seccomp.mjs [profile-url]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2] ?? 'https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json';
const res = await fetch(source);
if (!res.ok) throw new Error(`${source}: ${res.status}`);
const profile = await res.json();
if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls)) {
  throw new Error('Beklenmeyen profil biçimi');
}
// The first five were each needed: without any of them bwrap stops (checked by removing them one at
// a time). chroot is for Chromium's sandbox.
profile.syscalls.push({
  names: ['clone', 'unshare', 'mount', 'umount2', 'pivot_root', 'chroot'],
  action: 'SCMP_ACT_ALLOW',
});
const out = join(dirname(fileURLToPath(import.meta.url)), 'seccomp.json');
writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`yazıldı: ${out}`);
