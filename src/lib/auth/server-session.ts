import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";
import { isWellFormedToken } from "@/lib/security/tokens";
import { type AuthContext, getAuthContext } from "./context";
import { sessionCookieName } from "./cookies";
import { getAuthRuntime } from "./runtime";

// For pages (server components): who is signed in right now?
// Returns null when there is no cookie or the session is not valid (expired, revoked, user or
// organization disabled, ...). The reason is deliberately not returned: the page treats all of them the same.
//
// Reading the cookie makes the page "request-time" content, so any page that calls this must
// do so inside a <Suspense> boundary (Cache Components rule).
// Wrapped in React's cache(): the layout and the page both ask "who is signed in?", but the
// session is checked (and its idle deadline extended) only once per request.
export const getCurrentAuth = cache(async function getCurrentAuth(): Promise<AuthContext | null> {
  // Say "this needs a real request" BEFORE anything touches the clock or the database client.
  // Without it, Next.js's prerender pass sees the clock being read and reports an error.
  await connection();
  const rt = getAuthRuntime();
  const token = (await cookies()).get(sessionCookieName(rt.appOrigin))?.value;
  if (!isWellFormedToken(token)) return null;
  const result = await getAuthContext(rt.db, token, { now: rt.now(), timings: rt.timings, touch: true });
  return result.ok ? result.ctx : null;
});
