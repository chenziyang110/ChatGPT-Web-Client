import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Details = Record<string, string | number | boolean | undefined>;
const MAX_LOG_BYTES = 512 * 1024;

/** Local lifecycle records only. Never record prompts, URLs, account IDs or credentials. */
export class RuntimeDiagnostics {
  private readonly logFile: string;
  private readonly sessionFile: string;
  constructor(private readonly directory: string, private readonly version: string) {
    this.logFile = path.join(directory, 'runtime.jsonl');
    this.sessionFile = path.join(directory, 'session.json');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (existsSync(this.sessionFile)) {
        const previous = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
        if (previous.clean === false) this.record('previous_exit_incomplete');
      }
    } catch { /* Diagnostics must never prevent startup. */ }
    this.record('starting');
    this.session(false);
  }
  record(event: string, details: Details = {}): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (existsSync(this.logFile) && statSync(this.logFile).size >= MAX_LOG_BYTES)
        renameSync(this.logFile, `${this.logFile}.previous`);
      appendFileSync(this.logFile, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid,
        version: this.version, event, ...details })}\n`, { mode: 0o600 });
    } catch { /* A full disk or unwritable log directory must not stop queues. */ }
  }
  error(event: string, value: unknown): void {
    const error = value instanceof Error ? value : undefined;
    const code = error && 'code' in error ? String(error.code) : '';
    // The exception message can contain user input. Keep only the error class,
    // safe error code and compiled source locations for diagnosis.
    const sites = (error?.stack ?? '').split('\n').slice(1).flatMap(line => {
      const match = /[/\\]([^/\\()\s]+\.(?:c?js|ts)):(\d+):(\d+)\)?$/.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 5).join(',');
    this.record(event, { name: error?.name.replace(/[^\w]/g, '').slice(0, 50) ?? 'Unknown',
      code: /^[\w-]{1,60}$/.test(code) ? code : undefined, sites: sites || undefined });
  }
  finish(reason: string): void { this.record('stopped', { reason }); this.session(true); }
  private session(clean: boolean): void {
    try {
      writeFileSync(this.sessionFile, JSON.stringify({ clean, version: this.version, pid: process.pid,
        time: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* The event log remains useful if the marker cannot be written. */ }
  }
}
