import "server-only";

// Cross-site request forgery (CSRF) check for Route Handlers that use the session cookie.
// (Next.js Server Actions already do their own Origin/Host check; we leave that untouched.)

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type OriginCheck = { ok: true } | { ok: false; reason: string };

const originOf = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export function checkSameOrigin(
  request: { method: string; headers: { get(name: string): string | null } },
  appOrigin: string,
): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  const expected = new URL(appOrigin).origin;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return originOf(origin) === expected ? { ok: true } : { ok: false, reason: "origin_mismatch" };
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return { ok: true };
  if (site) return { ok: false, reason: "cross_site" };
  const referer = originOf(request.headers.get("referer"));
  if (referer === expected) return { ok: true };
  return { ok: false, reason: "no_origin" };
}

export function forbiddenResponse(): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
