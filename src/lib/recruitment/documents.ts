import "server-only";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import { staffDb } from "@/lib/db-context";
import { type AppDeps, applicationScope, isUuid } from "./applications";
import { notFound } from "./errors";

// Candidate documents (resumes) are private. A file can be read only by a signed-in person who
//   1. has the document:read permission,
//   2. belongs to the organisation the file was submitted to, and
//   3. may see the application it came with (so "assigned only" people get assigned files only).
// There is no public address for any file; the only way out is this function.

export type DownloadableDocument = { name: string; mimeType: string; bytes: Uint8Array };

export async function readDocument(deps: AppDeps, ctx: AuthContext, documentId: string): Promise<DownloadableDocument> {
  const db = staffDb(deps.db, ctx); // the database checks who is asking (row-level security)
  requirePermission(ctx, "document:read");
  const organizationId = requireOrganizationId(ctx);
  const scope = applicationScope(ctx);
  // A wrong id, another organisation's file and a file the person may not see all look the same.
  if (!isUuid(documentId)) throw notFound("That document");
  const doc = await db.candidateDocument.findFirst({
    where: { id: documentId, organizationId, deletedAt: null, application: scope },
    select: { id: true, originalName: true, mimeType: true, storageKey: true, applicationId: true },
  });
  if (!doc) throw notFound("That document");
  const bytes = await deps.storage.get(doc.storageKey);
  if (!bytes) throw notFound("That document");
  // Reading someone's resume is recorded: who, when, and which file.
  await deps.writeAudit(db, {
    organizationId,
    actorUserId: ctx.user.id,
    action: "document.downloaded",
    entityType: "candidate_document",
    entityId: doc.id,
    metadata: { applicationId: doc.applicationId },
    ...deps.client,
    now: deps.now,
  });
  return { name: doc.originalName, mimeType: doc.mimeType, bytes };
}
