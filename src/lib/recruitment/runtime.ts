import "server-only";
import { writeAudit } from "@/lib/auth/audit";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getClientIp } from "@/lib/security/client-ip";
import type { AppDeps } from "./applications";
import { getFileStorage } from "./storage";

// Everything the recruitment services need from the outside world for one request:
// the database, the clock, the audit writer, the private file store and who is calling (address, browser).
export function recruitmentDeps(headers: { get(name: string): string | null }): AppDeps {
  const rt = getAuthRuntime();
  return {
    db: rt.db,
    now: rt.now(),
    writeAudit,
    storage: getFileStorage(),
    client: {
      ipAddress: getClientIp(headers, { hops: rt.trustedProxyHops, header: rt.clientIpHeader }),
      userAgent: headers.get("user-agent"),
    },
  };
}
