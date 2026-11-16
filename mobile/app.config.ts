import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// The Expo account and project the app is released from belong to whoever releases it, not to the source code, so
// they live in app.local.json, which git ignores. That file is not uploaded to the EAS build server; the server names
// the project in EAS_BUILD_PROJECT_ID instead.
interface LocalConfig {
  owner?: string;
  projectId?: string;
}

function readLocalConfig(): LocalConfig {
  const file = join(__dirname, 'app.local.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LocalConfig) : {};
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const local = readLocalConfig();
  const projectId = local.projectId ?? process.env.EAS_BUILD_PROJECT_ID;
  return {
    ...config,
    ...(local.owner ? { owner: local.owner } : {}),
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  } as ExpoConfig;
};
