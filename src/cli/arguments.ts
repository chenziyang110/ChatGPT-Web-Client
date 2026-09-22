export function argumentsFor(args: string[]): { positional: string[]; options: Record<string, string | boolean> } {
  const boolean = new Set(['submit', 'wait', 'new', 'current', 'acknowledged', 'background']);
  const valued = new Set(['data-dir', 'account', 'conversation', 'url', 'alias', 'text', 'text-file', 'idempotency-key', 'reply-timeout', 'idle-timeout', 'wait-timeout']);
  const positional: string[] = []; const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { positional.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${arg}`);
    if (boolean.has(key)) options[key] = true;
    else if (valued.has(key)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { positional, options };
}
export function seconds(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 3600) throw new Error('Timeout must be 1–3600 seconds');
  return Math.round(number * 1000);
}
