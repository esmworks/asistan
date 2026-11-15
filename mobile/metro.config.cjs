// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The shared package is written for Node's ESM resolution, where a TypeScript file is imported
// as `./name.js`. Metro looks for that file literally, so a relative `.js` import that fails is
// tried again without the extension, which finds the `.ts` source.
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const next = resolve ?? context.resolveRequest;
  try {
    return next(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
      return next(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = config;
