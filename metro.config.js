const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const POLYFILL_DIR = path.resolve(__dirname, 'node-polyfills');

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  events: path.join(POLYFILL_DIR, 'events.js'),
  process: path.join(POLYFILL_DIR, 'process.js'),
  '@xmpp/events': path.join(POLYFILL_DIR, 'xmpp-events-polyfill.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // expo-quick-actions publica su entry SOLO vía "exports" (sin "main");
  // este Metro (SDK 52, package exports off) cae al default `index` que no
  // existe. Mapeo directo al build real.
  if (moduleName === 'expo-quick-actions') {
    return {
      type: 'sourceFile',
      filePath: path.join(
        __dirname,
        'node_modules/expo-quick-actions/build/index.js',
      ),
    };
  }
  if (
    moduleName === '@xmpp/tcp' ||
    moduleName === '@xmpp/tls' ||
    moduleName === '@xmpp/starttls'
  ) {
    return {
      type: 'sourceFile',
      filePath: path.join(POLYFILL_DIR, 'xmpp-transport.js'),
    };
  }
  if (moduleName === '@xmpp/resolve') {
    return {
      type: 'sourceFile',
      filePath: path.join(POLYFILL_DIR, 'xmpp-resolve.js'),
    };
  }
  if (
    moduleName === 'node:dns' ||
    moduleName === 'node:net' ||
    moduleName === 'node:tls' ||
    moduleName === 'dns' ||
    moduleName === 'net' ||
    moduleName === 'tls'
  ) {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
