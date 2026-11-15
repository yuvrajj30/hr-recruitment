-- Milestone 3: applications and candidate pipeline.
-- Additive only: one new table, one new nullable column, one new permission, one role adjustment.
-- No existing table is rewritten and no existing row is deleted, except two role-permission links (see part 4).
-- Everything below runs as ONE transaction. If any statement fails, nothing is kept.
BEGIN;

-- 1. Who entered an application by hand (empty = the candidate applied themselves)
-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "created_by_id" UUID;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Recruiter assignment history
-- CreateTable
CREATE TABLE "application_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "recruiter_id" UUID,
    "assigned_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_assignments_org_app_created_idx" ON "application_assignments"("organization_id", "application_id", "created_at");

-- CreateIndex
CREATE INDEX "application_assignments_recruiter_id_idx" ON "application_assignments"("recruiter_id");

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_recruiter_id_fkey" FOREIGN KEY ("recruiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Extra rule that Prisma's schema language cannot express (added by hand):
-- the history is append-only. The only change allowed is clearing a user reference when that user is removed.
-- Deletes happen only through the cascade from applications (so test data can be cleaned up).
CREATE FUNCTION "block_assignment_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'recruiter_id' - 'assigned_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'recruiter_id' - 'assigned_by_id')
     OR (NEW."recruiter_id" IS NOT NULL AND NEW."recruiter_id" IS DISTINCT FROM OLD."recruiter_id")
     OR (NEW."assigned_by_id" IS NOT NULL AND NEW."assigned_by_id" IS DISTINCT FROM OLD."assigned_by_id") THEN
    RAISE EXCEPTION 'application_assignments is append-only: rows cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "application_assignments_no_update"
  BEFORE UPDATE ON "application_assignments"
  FOR EACH ROW EXECUTE FUNCTION "block_assignment_updates"();

-- 3. New permission: viewing candidate documents (resumes). Safe to run again.
INSERT INTO "permissions" ("id", "key", "module", "description")
SELECT gen_random_uuid(), 'document:read', 'document', 'View and download candidate documents'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'document:read');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."key" IN ('ADMIN', 'HR_MANAGER', 'RECRUITER') AND r."is_system" AND p."key" = 'document:read'
ON CONFLICT DO NOTHING;

-- 4. Recruiters work only on what is assigned to them:
--    application:read -> application:read_assigned, candidate:read -> candidate:read_assigned.
--    Admin and HR Manager keep full access.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."key" = 'RECRUITER' AND r."is_system" AND p."key" IN ('application:read_assigned', 'candidate:read_assigned')
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND r."key" = 'RECRUITER' AND r."is_system" AND p."key" IN ('application:read', 'candidate:read');

COMMIT;
