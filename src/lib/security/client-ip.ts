import "server-only";
import { isIP } from "node:net";

type HeaderReader = { get(name: string): string | null };

function clean(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end === -1) return null;
    v = v.slice(1, end); // [::1]:8080 -> ::1
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) {
    v = v.slice(0, v.lastIndexOf(":")); // 1.2.3.4:5678 -> 1.2.3.4
  }
  if (v.startsWith("::ffff:") && isIP(v.slice(7)) === 4) v = v.slice(7); // IPv4-mapped IPv6
  return isIP(v) ? v : null;
}

// Returns the real client IP, or null when it cannot be trusted.
// Headers like X-Forwarded-For can be forged by anyone, so they are believed ONLY when the app
// is configured as sitting behind `hops` trusted proxies. The address is counted from the RIGHT
// of the list, which is the part our own proxies added, never the part the client wrote.
export function getClientIp(headers: HeaderReader, config: { hops: number; header: string }): string | null {
  if (config.hops <= 0) return null;
  const raw = headers.get(config.header);
  if (!raw) return null;
  if (config.header === "x-forwarded-for") {
    const list = raw.split(",");
    const index = list.length - config.hops;
    if (index < 0) return null; // fewer entries than proxies: something bypassed our proxy
    return clean(list[index]!);
  }
  return clean(raw); // single-value headers set by the proxy itself (cf-connecting-ip, x-real-ip)
}
