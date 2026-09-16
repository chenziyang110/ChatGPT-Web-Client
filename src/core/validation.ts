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
// OAuth remains inside the same profile; external links require user confirmation.
export function isAccountNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.google.com',
        'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'].includes(url.hostname);
  } catch { return false; }
}
