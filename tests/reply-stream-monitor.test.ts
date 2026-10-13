import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyStreamMonitor, type ReplyStreamWebRequest } from '../src/main/ReplyStreamMonitor';

type HeadersListener = NonNullable<Parameters<ReplyStreamWebRequest['onHeadersReceived']>[1]>;
type CompletedListener = NonNullable<Parameters<ReplyStreamWebRequest['onCompleted']>[1]>;
type ErrorListener = NonNullable<Parameters<ReplyStreamWebRequest['onErrorOccurred']>[1]>;
type Headers = Parameters<HeadersListener>[0];

class MockWebRequest implements ReplyStreamWebRequest {
  headers: HeadersListener | null = null;
  completed: CompletedListener | null = null;
  error: ErrorListener | null = null;
  filters: string[][] = [];

  onHeadersReceived(filter: { urls: string[] }, listener: HeadersListener | null): void {
    this.filters.push(filter.urls);
    this.headers = listener;
  }
  onCompleted(filter: { urls: string[] }, listener: CompletedListener | null): void {
    this.filters.push(filter.urls);
    this.completed = listener;
  }
  onErrorOccurred(filter: { urls: string[] }, listener: ErrorListener | null): void {
    this.filters.push(filter.urls);
    this.error = listener;
  }

  receive(details: Headers): void {
    const responses: {}[] = [];
    this.headers?.(details, response => responses.push(response));
    assert.deepEqual(responses, [{}], 'the original response always continues without changes');
  }
  fail(details: Headers, error = 'net::ERR_CONNECTION_RESET'): void {
    this.error?.({ ...details, error });
  }
}

const stream = (id = 1, webContentsId = 10): Headers => ({
  id,
  url: 'https://chatgpt.com/backend-api/reply',
  webContentsId,
  resourceType: 'xhr',
  initiatorOrigin: 'https://chatgpt.com',
  frame: { parent: null, url: 'https://chatgpt.com/c/conversation' },
  statusCode: 200,
  responseHeaders: { 'Content-Type': ['text/event-stream; charset=utf-8'] },
});

function fixture(options?: { maxTrackedRequests?: number }) {
  const request = new MockWebRequest();
  const interrupted: number[] = [];
  const monitor = new ReplyStreamMonitor(request, id => interrupted.push(id), options);
  return { request, interrupted, monitor };
}

test('reports an interrupted top-level ChatGPT reply transport once without reading payloads', () => {
  const { request, interrupted } = fixture();
  const details = stream();
  Object.defineProperties(details, {
    uploadData: { get: () => { throw new Error('request body must not be accessed'); } },
    responseBody: { get: () => { throw new Error('response body must not be accessed'); } },
  });
  request.receive(details);
  request.fail(details);
  request.fail(details);
  assert.deepEqual(interrupted, [10]);
  assert.deepEqual(request.filters, Array(3).fill(['https://chatgpt.com/*']));
});

test('normal completion never reports task completion and cannot clear another stream on the same page', () => {
  const { request, interrupted } = fixture();
  const first = stream(1);
  const second = stream(2);
  request.receive(first);
  request.receive(second);
  request.completed?.(first);
  request.fail(first);
  assert.deepEqual(interrupted, []);
  request.fail(second, 'ERR_INCOMPLETE_CHUNKED_ENCODING');
  assert.deepEqual(interrupted, [10]);
});

test('ignores cancellation, client policy, authentication, and unknown errors', () => {
  const { request, interrupted } = fixture();
  for (const error of [
    'net::ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE',
    'ERR_ACCESS_DENIED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_FAILED',
    'UNKNOWN_FAILURE', 'ERR_CONNECTION_RESET extra text',
  ]) {
    const details = stream();
    request.receive(details);
    request.fail(details, error);
    request.fail(details);
  }
  assert.deepEqual(interrupted, []);
});

test('rejects foreign origins, subframes, ordinary responses, and incomplete ownership metadata', () => {
  const { request, interrupted } = fixture();
  const variants: Partial<Headers>[] = [
    { url: 'https://chatgpt.com.evil.example/reply' },
    { url: 'https://other.example/reply' },
    { url: 'http://chatgpt.com/reply' },
    { url: 'not a url' },
    { initiatorOrigin: 'https://other.example' },
    { initiatorOrigin: 'null' },
    { frame: { parent: {}, url: 'https://chatgpt.com/' } },
    { frame: { parent: null, url: 'https://other.example/' } },
    { frame: null },
    { frame: undefined },
    { resourceType: 'mainFrame' },
    { resourceType: 'script' },
    { statusCode: 302 },
    { statusCode: 401 },
    { responseHeaders: { 'content-type': ['application/json'] } },
    { responseHeaders: { 'content-type': ['text/event-streaming'] } },
    { responseHeaders: undefined },
    { webContentsId: undefined },
    { webContentsId: 0 },
    { webContentsId: NaN },
    { id: -1 },
  ];
  for (const variant of variants) {
    const details = { ...stream(), ...variant };
    request.receive(details);
    request.fail(details);
  }
  assert.deepEqual(interrupted, []);
});

test('accepts EventSource metadata when the top-level frame proves origin and the header casing differs', () => {
  const { request, interrupted } = fixture();
  const details = {
    ...stream(), resourceType: 'other', initiatorOrigin: undefined,
    responseHeaders: { 'cOnTeNt-TyPe': ['TEXT/EVENT-STREAM ; charset=UTF-8'] },
  };
  request.receive(details);
  request.fail(details, 'ERR_NETWORK_CHANGED');
  assert.deepEqual(interrupted, [10]);
});

test('forgetting a navigated or destroyed page preserves other pages and suppresses its late errors', () => {
  const { request, interrupted, monitor } = fixture();
  const first = stream(1, 10);
  const second = stream(2, 10);
  const other = stream(3, 20);
  for (const details of [first, second, other]) request.receive(details);
  monitor.forget(10);
  for (const details of [first, second, other]) request.fail(details);
  assert.deepEqual(interrupted, [20]);
});

test('bounded tracking evicts oldest entries without changing the response or reporting false failure', () => {
  const { request, interrupted } = fixture({ maxTrackedRequests: 2 });
  const first = stream(1, 10);
  const second = stream(2, 20);
  const third = stream(3, 30);
  for (const details of [first, second, third]) request.receive(details);
  request.fail(first);
  assert.deepEqual(interrupted, []);
  request.fail(second);
  request.fail(third);
  assert.deepEqual(interrupted, [20, 30]);
});

test('a replaced header classification and mismatched ownership cannot notify the wrong page', () => {
  const { request, interrupted } = fixture();
  request.receive(stream());
  request.receive({ ...stream(), statusCode: 401 });
  request.fail(stream());
  request.receive(stream());
  request.fail({ ...stream(), webContentsId: 20 });
  request.fail(stream());
  request.receive(stream());
  request.fail({ ...stream(), url: 'https://other.example/reply' });
  request.fail(stream());
  assert.deepEqual(interrupted, []);
});

test('detached-frame metadata and recovery callback errors cannot break response handling', () => {
  const request = new MockWebRequest();
  new ReplyStreamMonitor(request, () => { throw new Error('recovery unavailable'); });
  const details = stream();
  Object.defineProperty(details.frame, 'parent', { get: () => { throw new Error('Frame disposed'); } });
  request.receive(details);
  request.fail(details);
  request.receive(stream(2));
  assert.doesNotThrow(() => request.fail(stream(2)));
});

test('disposal removes every listener and ignores any callback already queued', () => {
  const { request, interrupted, monitor } = fixture();
  const headers = request.headers!;
  const error = request.error!;
  request.receive(stream());
  monitor.dispose();
  monitor.dispose();
  assert.equal(request.headers, null);
  assert.equal(request.completed, null);
  assert.equal(request.error, null);
  const responses: {}[] = [];
  headers(stream(2), response => responses.push(response));
  error({ ...stream(), error: 'ERR_CONNECTION_RESET' });
  assert.deepEqual(responses, [{}]);
  assert.deepEqual(interrupted, []);
  assert.equal(request.filters.length, 6);
});

test('tracking limits cannot permit unbounded memory or invalid eviction', () => {
  for (const maxTrackedRequests of [0, -1, 4097, Infinity, 1.5]) {
    assert.throws(() => fixture({ maxTrackedRequests }), RangeError);
  }
});
