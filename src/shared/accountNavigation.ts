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

// OS protocols must be explicitly supported, never inferred from arbitrary web links.
export function isCodexAppUrl(value: string): boolean {
  if (value.length > 16384 || /[\u0000-\u0020\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return value.toLowerCase().startsWith('codex://') && url.protocol === 'codex:' &&
      !!url.hostname && !url.username && !url.password && !url.port;
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
    if (isCodexAppUrl(targets[0]) && !url.hash) return url.href;
  } catch { /* Only a supported, explicitly supplied callback receives an exception. */ }
}

export function isAuthorizationCallback(value: string, callback?: string): boolean {
  if (!callback) return false;
  try {
    const url = new URL(value), target = new URL(callback);
    if (target.username || target.password || target.hash) return false;
    const loopback = target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    const native = isCodexAppUrl(callback) && isCodexAppUrl(value);
    return (loopback && url.protocol === 'http:' || native) && !url.username && !url.password && !url.hash &&
      url.protocol === target.protocol && url.host === target.host && url.pathname === target.pathname &&
      [...target.searchParams].every(([key, entry]) => url.searchParams.getAll(key).includes(entry));
  } catch { return false; }
}

export function isAuthorizationSuccess(value: string, callback?: string): boolean {
  if (!callback) return false;
  try {
    const url = new URL(value), target = new URL(callback);
    // Codex's loopback server exchanges the code, then returns a success page
    // which opens codex://threads/new. Keep the exact declared host and port.
    return target.protocol === 'http:' && !target.username && !target.password && !target.hash &&
      ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/auth/callback' &&
      url.origin === target.origin && url.pathname === '/success' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export function isNativeAppAuthorizationSource(value: string, callback?: string): boolean {
  const host = accountHost(value);
  return host === 'chatgpt.com' || host === 'auth.openai.com' || host === 'auth0.openai.com' ||
    isAuthorizationCallback(value, callback) || isAuthorizationSuccess(value, callback) ||
    !!callback && isCodexAppUrl(callback) && isHttpsWebUrl(value);
}

export function hasAuthorizationParameters(value: string): boolean {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    return ['code', 'state', 'access_token', 'id_token', 'oauth_token', 'oauth_verifier']
      .some(key => url.searchParams.has(key) || fragment.has(key));
  } catch { return false; }
}
