import { DEFAULT_LOGIN_REDIRECT } from "./config";

// After login the user may be sent back to the page they wanted ("?next=/jobs").
// Only plain paths inside THIS app are allowed; anything that could lead to another site is dropped.
// This stops "open redirect" tricks such as  ?next=//evil.com  or  ?next=/\evil.com.

const MAX_LENGTH = 512;
const PLACEHOLDER_ORIGIN = "http://placeholder.invalid";

// Control characters (tabs and newlines are silently removed by URL parsers, which can turn
// "/<TAB>/evil.com" into "//evil.com"), plus whitespace and backslashes.
const FORBIDDEN_CHARS = /[\u0000- \u007f\\]/;

// Pages that make no sense as a destination right after signing in.
const NOT_ALLOWED_PREFIXES = ["/login", "/api"];

const startsWithSegment = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

export function sanitizeRedirectPath(input: unknown, fallback: string = DEFAULT_LOGIN_REDIRECT): string {
  if (typeof input !== "string") return fallback;
  if (input.length === 0 || input.length > MAX_LENGTH) return fallback;
  if (!input.startsWith("/") || input.startsWith("//")) return fallback;
  if (FORBIDDEN_CHARS.test(input)) return fallback;

  let url: URL;
  try {
    url = new URL(input, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  // Must still be on our own origin after parsing, and must not smuggle in a second "//" at the start.
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
  if (url.pathname.startsWith("//")) return fallback;

  const path = url.pathname + url.search; // the #fragment is dropped on purpose
  if (NOT_ALLOWED_PREFIXES.some((p) => startsWithSegment(path, p))) return fallback;
  return path;
}
