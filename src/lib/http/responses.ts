// One place that builds every auth response, so none of them can forget the safety headers.
//   - Cache-Control: no-store   (browsers and proxies must never keep an auth response)
//   - X-Content-Type-Options: nosniff
//   - the same {"error": "<code>"} shape for every failure, and never any internal detail

export type ErrorCode =
  | "invalid_request" // 400
  | "unauthorized" // 401  not signed in
  | "invalid_credentials" // 401  wrong email or password (all causes look the same)
  | "forbidden" // 403
  | "payload_too_large" // 413
  | "unsupported_media_type" // 415
  | "too_many_attempts" // 429
  | "server_error" // 500
  | "server_busy"; // 503  too many logins at once; try again in a moment

type Options = {
  cookies?: string[]; // each value becomes its own Set-Cookie header
  headers?: Record<string, string>;
};

export function jsonResponse(body: unknown, status = 200, options: Options = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  for (const cookie of options.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(
  code: ErrorCode,
  status: number,
  options: Options & { extra?: Record<string, string | number> } = {},
): Response {
  return jsonResponse({ error: code, ...options.extra }, status, options);
}
