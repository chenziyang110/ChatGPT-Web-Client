import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizationCallback,
  isAuthorizationCallback,
  isAuthorizationSuccess,
  isCodexAppUrl,
  isNativeAppAuthorizationSource,
} from '../src/shared/accountNavigation';

const declareCallback = (callback: string) =>
  'https://auth.openai.com/oauth/authorize?redirect_uri=' + encodeURIComponent(callback);

test('Codex app destinations accept bounded URLs without credentials, ports, or control characters', () => {
  for (const value of ['codex://threads/new', 'codex://connector/oauth_callback?code=synthetic&state=state', 'codex://threads/new#fragment']) {
    assert.equal(isCodexAppUrl(value), true, value);
  }
  for (const value of [
    'javascript:alert(1)', 'file:///C:/secret.txt', 'vscode://threads/new',
    'https://codex.example/threads/new', 'codex:/threads/new', 'codex://',
    'codex://user:password@threads/new', 'codex://threads:123/new',
    'codex://threads/new\n', '\tcodex://threads/new', 'codex://threads/\u0000new',
    'codex://threads/new?state=%0Asecret', 'codex://threads/new?state=%1fsecret',
    'codex://threads/' + 'a'.repeat(16384),
  ]) assert.equal(isCodexAppUrl(value), false, value.slice(0, 100));
  const prefix = 'codex://threads/';
  assert.equal(isCodexAppUrl(prefix + 'a'.repeat(16384 - prefix.length)), true);
});

test('authorization declarations accept exact loopback and Codex callbacks only', () => {
  for (const callback of [
    'http://127.0.0.1:1455/auth/callback', 'http://localhost:43127/auth/callback?channel=desktop',
    'http://[::1]:43127/auth/callback', 'codex://connector/oauth_callback?channel=desktop',
  ]) assert.equal(authorizationCallback(declareCallback(callback)), callback);
  assert.equal(authorizationCallback('https://auth.openai.com/oauth/authorize'), undefined);
  for (const callback of [
    'http://127.0.0.1.evil.example:1455/auth/callback', 'http://evil.example/auth/callback',
    'https://127.0.0.1:1455/auth/callback', 'http://user:pass@localhost:1455/auth/callback',
    'http://localhost:1455/auth/callback#fragment', 'javascript:alert(1)',
    'file:///C:/secret.txt', 'codex://user:pass@connector/oauth_callback', 'codex://connector:1455/oauth_callback',
  ]) assert.equal(authorizationCallback(declareCallback(callback)), undefined, callback);
  const callback = 'codex://connector/oauth_callback';
  assert.equal(authorizationCallback(declareCallback(callback) + '&redirect_uri=' + encodeURIComponent(callback)), callback);
  assert.throws(() => authorizationCallback(declareCallback(callback) + '&redirect_uri=' + encodeURIComponent('codex://other/callback')));
});

test('callback matching preserves the declared host, port, path and required query values', () => {
  for (const callback of ['http://localhost:1455/auth/callback?channel=desktop', 'codex://connector/oauth_callback?channel=desktop']) {
    assert.equal(isAuthorizationCallback(callback + '&code=synthetic&state=state', callback), true);
    for (const value of [
      callback.replace('channel=desktop', 'channel=other'), callback.replace('?channel=desktop', '?code=synthetic'),
      callback.replace(new URL(callback).pathname, '/other'), callback + '#secret',
    ]) assert.equal(isAuthorizationCallback(value, callback), false, value);
  }
  const callback = 'http://127.0.0.1:1455/auth/callback';
  for (const value of [
    'http://localhost:1455/auth/callback?code=synthetic', 'http://127.0.0.1:1456/auth/callback?code=synthetic',
    'https://127.0.0.1:1455/auth/callback', 'http://user:pass@127.0.0.1:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback/extra',
  ]) assert.equal(isAuthorizationCallback(value, callback), false, value);
  assert.equal(isAuthorizationCallback('codex://other/oauth_callback', 'codex://connector/oauth_callback'), false);
  assert.equal(isAuthorizationCallback('codex://connector/oauth_callback'), false);
});

test('Codex loopback success is allowed only at the exact callback origin and /success path', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const origin = 'http://' + host + ':1455';
    assert.equal(isAuthorizationSuccess(origin + '/success?id_token=synthetic', origin + '/auth/callback'), true);
    for (const [value, callback] of [
      [origin + '/success/extra', origin + '/auth/callback'],
      [origin + '/other', origin + '/auth/callback'],
      [origin + '/success#secret', origin + '/auth/callback'],
      [origin.replace(':1455', ':1456') + '/success', origin + '/auth/callback'],
      [origin + '/success', origin + '/callback'],
      [origin + '/success', 'codex://connector/oauth_callback'],
    ]) assert.equal(isAuthorizationSuccess(value, callback), false, value + ' for ' + callback);
  }
  assert.equal(isAuthorizationSuccess('http://127.0.0.1:1455/success'), false);
});

test('native app handoff sources require an exact trusted HTTPS origin or declared callback context', () => {
  for (const host of ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com']) {
    assert.equal(isNativeAppAuthorizationSource('https://' + host + '/oauth/authorize?state=synthetic'), true);
  }
  for (const value of [
    'https://evil.example/', 'https://auth.openai.com.evil.example/', 'https://sub.auth.openai.com/',
    'https://auth.openai.com:444/', 'https://user:pass@auth.openai.com/', 'http://auth.openai.com/',
    'about:blank', 'codex://threads/new', 'http://127.0.0.1:1455/success',
  ]) assert.equal(isNativeAppAuthorizationSource(value), false, value);
  const callback = 'http://127.0.0.1:1455/auth/callback?channel=desktop';
  assert.equal(isNativeAppAuthorizationSource(callback + '&code=synthetic', callback), true);
  assert.equal(isNativeAppAuthorizationSource('http://127.0.0.1:1455/success?id_token=synthetic', callback), true);
  for (const value of ['http://localhost:1455/success', 'http://127.0.0.1:1456/success', 'http://127.0.0.1:1455/other', 'https://evil.example/']) {
    assert.equal(isNativeAppAuthorizationSource(value, callback), false, value);
  }
  assert.equal(isNativeAppAuthorizationSource('https://custom.example/start', 'codex://connector/oauth_callback'), true);
  assert.equal(isNativeAppAuthorizationSource('https://user:pass@custom.example/start', 'codex://connector/oauth_callback'), false);
});
