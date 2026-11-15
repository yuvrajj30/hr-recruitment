import { sanitizeRedirectPath } from "./redirect";

// The decision made by src/proxy.ts for every page request, kept as a plain function so it can be tested.
//
// This is only a FIRST, cheap gate: "is there a session cookie at all?". It cannot tell whether the
// session is still valid (that needs the database). Every protected page and API still checks the
// real session itself, so a forged or stale cookie gets past this gate but not past the page.

export type GateDecision = { kind: "allow" } | { kind: "redirect"; location: string };

const PUBLIC_PATHS = new Set(["/login"]);
// The public careers pages: job listings and application forms that candidates use without an account.
// "/careers" must be the whole first folder, so a future page such as /careers-admin is still protected.
const isPublicPath = (path: string) => PUBLIC_PATHS.has(path) || path === "/careers" || path.startsWith("/careers/");

export function decideGate(input: { pathname: string; search: string; hasSessionCookie: boolean }): GateDecision {
  const path = input.pathname.length > 1 ? input.pathname.replace(/\/+$/, "") : input.pathname;
  if (isPublicPath(path)) return { kind: "allow" };
  if (input.hasSessionCookie) return { kind: "allow" };

  // Remember where the person was going, unless that is the home page or something unsafe.
  const wanted = sanitizeRedirectPath(`${path}${input.search}`, "");
  const keep = wanted !== "" && wanted !== "/";
  return { kind: "redirect", location: keep ? `/login?next=${encodeURIComponent(wanted)}` : "/login" };
}
