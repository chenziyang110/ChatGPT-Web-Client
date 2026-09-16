import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildAgent(platform = process.platform, arch = process.arch, directory = path.resolve('dist-agent')) {
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const goarch = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!goos || !goarch) throw new Error(`Unsupported target: ${platform}/${arch}`);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, platform === 'win32' ? 'chatgpt-agent.exe' : 'chatgpt-agent');
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', file, '.'], {
    cwd: path.resolve('agent-cli'), stdio: 'inherit',
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
  });
  if (platform !== 'win32') chmodSync(file, 0o755);
  console.log(`Built Agent: ${platform}/${arch}`);
  return file;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--all')) {
    for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
      buildAgent(platform, arch, path.resolve('dist-agent', `${platform}-${arch}`));
    }
  } else buildAgent();
}
