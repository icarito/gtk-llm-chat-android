const process = {
  nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
  cwd: () => '/',
  env: {},
  versions: { node: '18.0.0' },
  exit: () => {},
  argv: [],
  pid: 0,
  platform: 'android',
  title: 'react-native',
};

global.process = global.process || process;

export default process;
