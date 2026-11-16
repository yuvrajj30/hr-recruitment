import "server-only";

// Remembers which session token a request's AuthContext was built from, WITHOUT putting the token on the
// context object itself: it can therefore never end up in a log line, in JSON, or in props sent to the
// browser. The database uses the token to work out who is asking (see the security_hardening migration):
// row-level security trusts a live session, not a user id stated by the application.
//
// The link is to the exact context object returned by getAuthContext(). A copy of that object has no token,
// and staffDb() then refuses to run: it fails closed rather than guess.

const TOKENS = new WeakMap<object, string>();

export function bindSessionToken(ctx: object, token: string): void {
  TOKENS.set(ctx, token);
}

export function sessionTokenOf(ctx: object): string | null {
  return TOKENS.get(ctx) ?? null;
}
