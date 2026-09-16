const path = require('node:path');
const { Arch } = require('builder-util');
exports.default = async context => {
  const { buildAgent } = await import('./build-agent.mjs');
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  buildAgent(platform, arch, path.resolve('dist-agent', `${platform}-${arch}`));
};
