/**
 * Structured, scrubbed logging.
 *
 * Logs must never carry secrets, connection strings, precise locations, contact details, pickup codes, incident text or
 * evidence. Two layers: (1) field NAMES that are sensitive are replaced wholesale, and (2) every string is scrubbed for
 * patterns that leak when they appear inside free text (driver errors embed SQL parameters, for example).
 */

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|pickup|codehash|latitude|longitude|^lat$|^lng$|^lon$|email|phone|address|contact|description|note|reason|storage|sha256|evidence|^params?$|^query$|^sql$|connection|^url$|^body$/i;

const REDACTED = '[redacted]';

export function scrubText(input: string): string {
  let s = input;
  // Drizzle appends the failed statement and its bound parameters to the message: drop both.
  const failed = s.indexOf('Failed query:');
  if (failed !== -1) s = `${s.slice(0, failed)}Failed query (statement and parameters withheld)`;
  s = s.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>]*@[^\s"'<>]*/gi, '$1://[redacted]'); // URLs with credentials
  s = s.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]*/gi, 'postgres://[redacted]');
  s = s.replace(/\b(pass(?:word)?|pwd|secret|token)\s*[=:]\s*[^\s,;"']+/gi, '$1=[redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  s = s.replace(/\b(fl_access|fl_refresh)=[^;\s]+/g, '$1=[redacted]');
  s = s.replace(/(invalid input syntax for [^:]+):\s*".*?"/gi, '$1: "[redacted]"');
  s = s.replace(/Key \([^)]*\)=\([^)]*\)/g, 'Key ([redacted])=([redacted])');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  s = s.replace(/-?\d{1,3}\.\d{4,}/g, '[number]'); // coordinates and other high-precision decimals
  return s;
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubValue(v, depth + 1);
    return out;
  }
  return String(typeof value);
}

/** A safe, small description of any thrown value: name, driver error code when there is one, scrubbed message. */
export function describeError(err: unknown): { name: string; code?: string; message: string } {
  if (!(err instanceof Error)) return { name: 'UnknownError', message: scrubText(String(err)).slice(0, 300) };
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  const own = (err as { code?: unknown }).code;
  const code = typeof cause?.code === 'string' ? cause.code : typeof own === 'string' ? own : undefined;
  // Prefer the driver's own message over the ORM wrapper (which embeds the statement).
  const raw = typeof cause?.message === 'string' ? cause.message : err.message;
  return { name: err.name, ...(code ? { code } : {}), message: scrubText(raw).slice(0, 300) };
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => (level === 'error' ? console.error(line) : level === 'warn' ? console.warn(line) : console.log(line));

export function createLogger(sink: LogSink = consoleSink) {
  const emit = (level: LogLevel) => (msg: string, fields: Record<string, unknown> = {}) =>
    sink(level, JSON.stringify({ level, msg: scrubText(msg), ...(scrubValue(fields) as Record<string, unknown>) }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const logger = createLogger();
