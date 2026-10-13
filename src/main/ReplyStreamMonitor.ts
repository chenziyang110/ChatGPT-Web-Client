interface RequestDetails {
  id: number;
  url: string;
  webContentsId?: number;
  resourceType: string;
  initiatorOrigin?: string;
  frame?: { parent: object | null; url: string } | null;
}

interface HeadersDetails extends RequestDetails {
  statusCode: number;
  responseHeaders?: Record<string, string[]>;
}

interface ErrorDetails extends RequestDetails {
  error: string;
}

interface RequestFilter {
  urls: string[];
}

/** Only the metadata used by the monitor; no Electron runtime import is required. */
export interface ReplyStreamWebRequest {
  onHeadersReceived(filter: RequestFilter, listener: ((details: HeadersDetails, callback: (response: {}) => void) => void) | null): void;
  onCompleted(filter: RequestFilter, listener: ((details: RequestDetails) => void) | null): void;
  onErrorOccurred(filter: RequestFilter, listener: ((details: ErrorDetails) => void) | null): void;
}

const origin = 'https://chatgpt.com';
const filter: RequestFilter = { urls: [`${origin}/*`] };

// Generic failures, cancellation, authentication, and policy failures are not
// evidence that a live reply connection was interrupted in transit.
const transportErrors = new Set([
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_EMPTY_RESPONSE',
  'ERR_CONTENT_LENGTH_MISMATCH',
  'ERR_INCOMPLETE_CHUNKED_ENCODING',
  'ERR_RESPONSE_HEADERS_TRUNCATED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_HTTP2_PING_FAILED',
  'ERR_HTTP2_SERVER_REFUSED_STREAM',
  'ERR_HTTP2_FLOW_CONTROL_ERROR',
  'ERR_HTTP2_FRAME_SIZE_ERROR',
  'ERR_HTTP2_COMPRESSION_ERROR',
  'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_QUIC_HANDSHAKE_FAILED',
  'ERR_SSL_PROTOCOL_ERROR',
]);

function sameOrigin(url: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function isReplyStream(details: HeadersDetails): boolean {
  if (!Number.isSafeInteger(details.id) || details.id < 0
    || !Number.isSafeInteger(details.webContentsId) || details.webContentsId! <= 0
    || !sameOrigin(details.url) || !['xhr', 'other'].includes(details.resourceType)
    || details.statusCode < 200 || details.statusCode >= 300) return false;

  // Missing or detached frame metadata cannot reliably attribute a stream to
  // the visible conversation. Subframes must not trigger page recovery.
  if (!details.frame || details.frame.parent !== null || !sameOrigin(details.frame.url)) return false;
  if (details.initiatorOrigin !== undefined && details.initiatorOrigin !== origin) return false;

  return Object.entries(details.responseHeaders ?? {}).some(([name, values]) =>
    name.toLowerCase() === 'content-type'
    && values.some(value => value.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream'));
}

/**
 * Passive hints for lost reply transports. Normal stream completion says
 * nothing about whether a server-side task is finished. The monitor retains
 * only request IDs and owning WebContents IDs, never URLs or response content.
 * The caller owns these three session listeners (Electron allows one each).
 */
export class ReplyStreamMonitor {
  private readonly requests = new Map<number, number>();
  private readonly limit: number;
  private disposed = false;

  constructor(
    private readonly webRequest: ReplyStreamWebRequest,
    private readonly onInterrupted: (webContentsId: number) => void,
    options: { maxTrackedRequests?: number } = {},
  ) {
    this.limit = options.maxTrackedRequests ?? 256;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 4096) {
      throw new RangeError('Reply stream tracking limit must be between 1 and 4096');
    }
    webRequest.onHeadersReceived(filter, this.headersReceived);
    webRequest.onCompleted(filter, this.completed);
    webRequest.onErrorOccurred(filter, this.errorOccurred);
  }

  /** Call before intentional navigation, view replacement, or destruction. */
  forget(webContentsId: number): void {
    for (const [requestId, owner] of this.requests) {
      if (owner === webContentsId) this.requests.delete(requestId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.clear();
    this.webRequest.onHeadersReceived(filter, null);
    this.webRequest.onCompleted(filter, null);
    this.webRequest.onErrorOccurred(filter, null);
  }

  private readonly headersReceived = (details: HeadersDetails, callback: (response: {}) => void): void => {
    try {
      if (this.disposed) return;
      this.requests.delete(details.id);
      if (!isReplyStream(details)) return;
      while (this.requests.size >= this.limit) {
        this.requests.delete(this.requests.keys().next().value!);
      }
      this.requests.set(details.id, details.webContentsId!);
    } catch {
      // A frame may detach while reading its metadata. Observing it must never
      // interfere with the original response or pause a network request.
    } finally {
      callback({});
    }
  };

  private readonly completed = (details: RequestDetails): void => {
    if (!this.disposed) this.requests.delete(details.id);
  };

  private readonly errorOccurred = (details: ErrorDetails): void => {
    if (this.disposed) return;
    const owner = this.requests.get(details.id);
    this.requests.delete(details.id);
    if (owner === undefined || owner !== details.webContentsId || !sameOrigin(details.url)) return;
    const error = details.error.replace(/^net::/, '');
    if (!transportErrors.has(error)) return;
    try { this.onInterrupted(owner); } catch {
      // Recovery is best effort; a consumer error must not crash the network
      // listener or affect any other conversation's stream.
    }
  };
}
