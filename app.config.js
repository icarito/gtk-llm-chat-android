const appJson = require('./app.json');

module.exports = () => {
  const config = { ...appJson.expo };
  config.plugins = [...(config.plugins ?? []), 'expo-sqlite'];
  return config;
};
