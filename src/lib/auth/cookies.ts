import { isWellFormedToken } from "@/lib/security/tokens";

// The session cookie, built and read as plain text so routes can use ordinary Request/Response
// objects (easy to test, no framework needed).
//
// Flags: HttpOnly (page scripts cannot read it), SameSite=Lax (not sent on cross-site POSTs),
// Path=/, and Secure + the "__Host-" name prefix whenever the app runs on https. The "__Host-"
// prefix makes browsers refuse a cookie that was planted by a sibling subdomain or over plain http.

const BASE_NAME = "hr_session";

const isHttps = (appOrigin: string) => new URL(appOrigin).protocol === "https:";

export function sessionCookieName(appOrigin: string): string {
  return isHttps(appOrigin) ? `__Host-${BASE_NAME}` : BASE_NAME;
}

function attributes(appOrigin: string): string[] {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (isHttps(appOrigin)) parts.push("Secure");
  return parts;
}

// Value for a "Set-Cookie" header that starts a session. The cookie lasts until the HARD deadline;
// the shorter idle deadline is enforced by the server using the database.
export function buildSessionCookie(opts: {
  appOrigin: string;
  token: string;
  absoluteExpiresAt: Date;
  now: Date;
}): string {
  // Refuse anything that is not a real token, so nothing odd can ever be written into a header.
  if (!isWellFormedToken(opts.token)) throw new Error("Refusing to set a malformed session token");
  const maxAge = Math.max(0, Math.floor((opts.absoluteExpiresAt.getTime() - opts.now.getTime()) / 1000));
  return [
    `${sessionCookieName(opts.appOrigin)}=${opts.token}`,
    `Max-Age=${maxAge}`,
    `Expires=${opts.absoluteExpiresAt.toUTCString()}`,
    ...attributes(opts.appOrigin),
  ].join("; ");
}

// Value for a "Set-Cookie" header that deletes the cookie (same name and attributes, already expired).
export function buildClearedSessionCookie(appOrigin: string): string {
  return [
    `${sessionCookieName(appOrigin)}=`,
    "Max-Age=0",
    `Expires=${new Date(0).toUTCString()}`,
    ...attributes(appOrigin),
  ].join("; ");
}

// Reads the session token out of a request's "Cookie" header.
// Returns null for a missing cookie or anything that is not shaped like a real token.
export function readSessionToken(cookieHeader: string | null | undefined, appOrigin: string): string | null {
  if (!cookieHeader) return null;
  const wanted = sessionCookieName(appOrigin);
  for (const piece of cookieHeader.split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq).trim() !== wanted) continue;
    const value = piece.slice(eq + 1).trim();
    // Browsers send the most specific cookie first; if the first one is not usable, treat as signed out.
    return isWellFormedToken(value) ? value : null;
  }
  return null;
}
