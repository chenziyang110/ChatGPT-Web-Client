import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('dist-agent');
mkdirSync(directory, { recursive: true });
const filename = process.platform === 'win32' ? 'chatgpt-agent.exe' : 'chatgpt-agent';
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(directory, filename), '.'], {
  cwd: path.resolve('agent-cli'), stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' }
});
console.log(`Built Go Agent CLI: ${path.join(directory, filename)}`);
