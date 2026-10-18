const appJson = require('./app.json');
const fs = require('fs');

const EAS_PROJECT_ID = 'd268fe19-6b55-44be-b813-97e7c026611a';

module.exports = () => {
  const config = { ...appJson.expo };
  config.owner = 'icaritos-team';
  config.plugins = [...(config.plugins ?? []), 'expo-sqlite'];
  if (fs.existsSync('./google-services.json')) {
    config.android = {
      ...(config.android ?? {}),
      googleServicesFile: './google-services.json',
    };
  }
  const buildNumber = parseInt(process.env.BUILD_NUMBER ?? '', 10);
  if (buildNumber > 0) {
    config.android = { ...config.android, versionCode: buildNumber };
    config.ios = { ...config.ios, buildNumber: String(buildNumber) };
  }
  config.extra = {
    ...(config.extra ?? {}),
    eas: {
      ...((config.extra && config.extra.eas) ?? {}),
      projectId: process.env.EXPO_PROJECT_ID ?? EAS_PROJECT_ID,
    },
    xmppPush: {
      serviceJid: 'expo-push.hablar.fuentelibre.org',
    },
  };
  return config;
};
