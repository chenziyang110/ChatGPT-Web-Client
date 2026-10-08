const LOGIN_HOSTS = new Set(['auth.openai.com', 'auth0.openai.com', 'accounts.google.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com']);

function accountHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url.hostname;
  } catch { /* Invalid destinations are not account pages. */ }
}

export function isAccountLoginUrl(value: string): boolean {
  const host = accountHost(value);
  if (!host) return false;
  if (LOGIN_HOSTS.has(host)) return true;
  // OpenAI may return to a ChatGPT callback before opening the conversation.
  return host === 'chatgpt.com' && /^\/(?:auth|api\/auth)(?:\/|$)/.test(new URL(value).pathname);
}

export function isAccountNavigation(value: string): boolean {
  return accountHost(value) === 'chatgpt.com' || isAccountLoginUrl(value);
}

export function isHttpsWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function authorizationCallback(value: string): string | undefined {
  const targets = new URL(value).searchParams.getAll('redirect_uri');
  if (new Set(targets).size > 1) throw new Error('授权链接包含多个不同的 redirect_uri，请使用完整的单一授权链接');
  if (!targets[0]) return;
  try {
    const url = new URL(targets[0]);
    if (url.protocol === 'http:' && !url.username && !url.password && !url.hash &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  } catch { /* Only an explicitly supplied loopback callback gets an HTTP exception. */ }
}

export function isAuthorizationCallback(value: string, callback?: string): boolean {
  if (!callback) return false;
  try {
    const url = new URL(value), target = new URL(callback);
    return url.protocol === 'http:' && !url.username && !url.password && !url.hash &&
      url.origin === target.origin && url.pathname === target.pathname &&
      [...target.searchParams].every(([key, entry]) => url.searchParams.getAll(key).includes(entry));
  } catch { return false; }
}

export function hasAuthorizationParameters(value: string): boolean {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    return ['code', 'state', 'access_token', 'id_token', 'oauth_token', 'oauth_verifier']
      .some(key => url.searchParams.has(key) || fragment.has(key));
  } catch { return false; }
}
