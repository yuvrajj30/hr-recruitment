import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { redact } from "@/lib/security/logger";

// Writes one row to the append-only audit log (it can be read and added to, never changed or deleted).
// Metadata goes through the same redaction as the logger, as a second safety net against secrets.

export type AuditEntry = {
  organizationId: string | null;
  actorUserId: string | null;
  action: string; // e.g. "auth.login_succeeded"
  entityType: string; // e.g. "session"
  entityId: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
};

export type AuditWriter = (db: Pick<Db, "auditLog">, entry: AuditEntry) => Promise<void>;

export const writeAudit: AuditWriter = async (db, entry) => {
  // createMany writes without reading the row back. That matters under row-level security: anyone may
  // add an audit record, but only a Super Admin may read the log, so a read-back would be refused.
  await db.auditLog.createMany({
    data: {
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
      ipAddress: entry.ipAddress ? entry.ipAddress.slice(0, 64) : null,
      userAgent: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
      createdAt: entry.now,
    },
  });
};
