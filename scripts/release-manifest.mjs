import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function releaseManifest(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable version required');
  const expected = ['x64', 'arm64'].flatMap(arch => [
    `ChatGPT-Web-Client-${version}-win-${arch}.exe`,
    `ChatGPT-Web-Client-${version}-mac-${arch}.dmg`,
    `ChatGPT-Web-Client-${version}-mac-${arch}.zip`,
    `ChatGPT-Web-Client-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`,
    `ChatGPT-Web-Client-${version}-linux-${arch}.tar.gz`
  ]).sort();
  const actual = (await readdir(directory)).filter(name => name !== 'SHA256SUMS.txt').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release must contain exactly all 10 installers/archives for six platform targets');
  const lines = [];
  for (const name of expected) {
    const bytes = await readFile(path.join(directory, name));
    if (!bytes.length) throw new Error(`Empty artifact: ${name}`);
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  return expected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  console.log(await releaseManifest('release', version));
}
