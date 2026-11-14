// Security headers for every response. Plain module (no server-only) so next.config.ts can import it.
// A full script-source Content-Security-Policy needs per-request nonces; that is added with the
// dashboard shell milestone. The directives below are safe to apply now.

export function securityHeaders(isProduction: boolean): { key: string; value: string }[] {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    {
      key: "Content-Security-Policy",
      value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    },
  ];
  if (isProduction) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }
  return headers;
}
