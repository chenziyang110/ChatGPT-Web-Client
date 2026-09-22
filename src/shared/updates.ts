export const RELEASES_URL = 'https://github.com/chenziyang110/ChatGPT-Web-Client/releases/latest';
export interface UpdateState {
  current: string;
  enabled: boolean;
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  installMode?: 'in-app' | 'manual' | 'development';
  progress?: number;
  error?: string;
  latest?: string;
  checkedAt?: string;
}

export function newerStable(candidate: string, current: string): boolean {
  const parse = (value: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
  const a = parse(candidate), b = parse(current);
  if (!a || !b || [...a, ...b].some(n => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

export function validUpdateMetadata(value: unknown, version: string, platform: string, arch: string): boolean {
  if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) ||
    !value || typeof value !== 'object' || !('version' in value) || value.version !== version ||
    !('files' in value) || !Array.isArray(value.files) || value.files.length !== 1) return false;
  const file = value.files[0];
  const suffix = platform === 'win32' ? `win-${arch}.exe` : `linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
  return !!file && typeof file === 'object' && file.url === `ChatGPT-Web-Client-${version}-${suffix}` &&
    typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512) &&
    Number.isSafeInteger(file.size) && file.size > 0 && file.size < 2 * 1024 * 1024 * 1024;
}
