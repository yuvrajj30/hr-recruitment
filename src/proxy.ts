import { type NextRequest, NextResponse } from "next/server";
import { readSessionToken } from "@/lib/auth/cookies";
import { decideGate } from "@/lib/auth/proxy-gate";

// Runs before every page request. It only answers "is there a session cookie at all?" and
// sends people without one to /login. It does NOT prove the session is valid: every protected
// page and API checks the real session in the database itself.

function hasSessionCookie(request: NextRequest): boolean {
  try {
    return readSessionToken(request.headers.get("cookie"), process.env.APP_ORIGIN ?? "") !== null;
  } catch {
    return false; // a bad APP_ORIGIN setting must never let anyone through
  }
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const decision = decideGate({ pathname, search, hasSessionCookie: hasSessionCookie(request) });
  if (decision.kind === "allow") return NextResponse.next();

  // 303 turns any method into a plain GET of the login page.
  const base = process.env.APP_ORIGIN || request.url;
  const response = NextResponse.redirect(new URL(decision.location, base), 303);
  response.headers.set("cache-control", "no-store");
  return response;
}

export const config = {
  // Skip the API folder (its routes check sessions themselves), Next.js internals, and files with an
  // extension. "api" must be the whole folder name, so a future page such as /apiary is still protected.
  matcher: ["/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
