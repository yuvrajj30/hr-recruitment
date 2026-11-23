// Security headers for every response (applied in next.config.ts). Plain module (no server-only) so next.config.ts
// can import it.
//
// The Content-Security-Policy keeps every kind of resource on this site: scripts, styles, fonts, images,
// connections, workers, frames (none) and plugins (none); no eval in production; forms and <base> only to this
// site; and no other site may frame these pages.
//
// Inline scripts and styles are allowed ('unsafe-inline'). A nonce-based policy would be stricter, but it needs
// every page rendered per request: the app pre-renders page shells (cacheComponents), and those shells' scripts
// cannot carry a per-request nonce (checked in a production build on 20 Nov 2026: 12 of 18 scripts on a careers
// page and all 21 on /login had none). Moving to nonces means giving up pre-rendering; that is a separate decision.

export function contentSecurityPolicy(opts: { isDev: boolean; isProduction: boolean }): string {
  const directives = [
    "default-src 'self'",
    // React needs eval only in development (debug stack traces), never in production.
    `script-src 'self' 'unsafe-inline'${opts.isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // Development hot reload talks to the dev server over a websocket on the same host.
    `connect-src 'self'${opts.isDev ? " ws: wss:" : ""}`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaders(opts: { isDev: boolean; isProduction: boolean }): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(opts) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
  if (opts.isProduction) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}
