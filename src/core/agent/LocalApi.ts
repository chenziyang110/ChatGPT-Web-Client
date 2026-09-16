import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, record, text } from '../validation';
export type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface Discovery { endpoint: string; token: string; pid: number; version: 1 }

export class LocalApi {
  private server?: Server;
  private token = '';
  endpoint: string | null = null;
  constructor(readonly discoveryFile: string, private readonly call: RpcHandler) {}
  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(32).toString('hex');
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxRequestsPerSocket = 100;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid API address');
    this.endpoint = `http://127.0.0.1:${address.port}`;
    try {
      mkdirSync(dirname(this.discoveryFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.discoveryFile}.tmp`;
      writeFileSync(temporary, JSON.stringify({ endpoint: this.endpoint, token: this.token, pid: process.pid, version: 1 } satisfies Discovery), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.discoveryFile);
      chmodSync(this.discoveryFile, 0o600);
    } catch (error) { await this.stop(); throw error; }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status; res.end(JSON.stringify(body)); } };
    try {
      // No browser clients, cross-origin requests or DNS rebinding hosts.
      if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers.host !== new URL(this.endpoint!).host) {
        throw new AppError('Browser origins and unexpected hosts are not allowed', 403);
      }
      const received = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AppError('Unauthorized', 401);
      if (req.method === 'GET' && req.url === '/health') { reply(200, { ok: true, version: 1 }); return; }
      if (req.method !== 'POST' || req.url !== '/v1/rpc') throw new AppError('Not found', 404);
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new AppError('Use application/json', 415);
      if (Number(req.headers['content-length'] ?? 0) > 65536) throw new AppError('Request too large', 413);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 65536) throw new AppError('Request too large', 413);
        chunks.push(Buffer.from(chunk));
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Invalid JSON'); }
      const input = record(parsed);
      const result = await this.call(text(input.method, 'Method', 80), input.params === undefined ? {} : record(input.params));
      reply(200, { ok: true, result: result ?? null });
    } catch (error) {
      reply(error instanceof AppError ? error.status : 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' });
    }
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = null;
    this.token = '';
    rmSync(this.discoveryFile, { force: true });
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}
