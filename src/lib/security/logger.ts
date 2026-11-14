import "server-only";

// A logger that cannot leak secrets: sensitive field names and token-looking strings are
// replaced before anything is written. Request bodies must never be passed to it.

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|hash|pepper|credential|otp|code/i;
const TOKEN_LIKE = /[A-Za-z0-9_-]{40,}/g;
const MAX_STRING = 500;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const masked = value.replace(TOKEN_LIKE, "[redacted-token]");
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
  }
  if (typeof value !== "object") return typeof value === "function" ? "[function]" : value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too-deep]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1, seen) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1, seen);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";
type Sink = (line: string) => void;

export function createLogger(sink: Sink = (line) => process.stdout.write(line + "\n")) {
  const write = (level: Level, event: string, fields?: Record<string, unknown>) => {
    sink(JSON.stringify({ time: new Date().toISOString(), level, event, ...(redact(fields ?? {}) as object) }));
  };
  return {
    debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
    info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
    error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
  };
}

export const logger = createLogger();
