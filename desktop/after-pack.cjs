// Copies the staged server (bundle plus production node_modules) into the packaged app.
// electron-builder leaves node_modules out of extraResources whatever the filter says,
// so the folder is copied here, before signing. Links inside it are relative and kept.
const { cpSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const staged = join(__dirname, '.stage', 'server');
  if (!existsSync(join(staged, 'node_modules'))) {
    throw new Error('Sunucu hazır değil: önce `pnpm stage` çalıştırın');
  }
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  const target = join(resources, 'server');
  rmSync(target, { recursive: true, force: true });
  cpSync(staged, target, { recursive: true, verbatimSymlinks: true });
};
