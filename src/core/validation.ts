import { isHttpsWebUrl } from '../shared/accountNavigation';
export { isAccountNavigation, isAccountLoginUrl } from '../shared/accountNavigation';

export class AppError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError(`${label} must contain 1–${max} characters`);
  }
  return value.trim();
}
export function identifier(value: unknown): string {
  const id = text(value, 'ID', 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new AppError('Invalid ID');
  return id;
}
export const HOME_URL = 'https://chatgpt.com/';
export function isChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
export function chatUrl(value: unknown): string {
  const url = text(value, 'URL', 4096);
  if (!isChatUrl(url)) throw new AppError('Only https://chatgpt.com URLs are supported');
  return new URL(url).href;
}
export function webLink(value: unknown): string {
  const url = text(value, '链接', 16384);
  if (!isHttpsWebUrl(url)) throw new AppError('请输入完整的 https:// 登录或授权链接');
  return new URL(url).href;
}
