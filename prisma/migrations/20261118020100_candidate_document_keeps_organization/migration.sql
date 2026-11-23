-- Follow-up to 20261118020000_candidate_profiles_per_organization: a candidate document now always belongs to
-- an organisation (organization_id is required). If its application is ever deleted, only the link to the
-- application is cleared; the document keeps its organisation. (A plain SET NULL on this two-column key would
-- also try to clear organization_id and fail.) PostgreSQL 15+ column list; Prisma still sees "SET NULL".
-- No existing data is changed.
BEGIN;

ALTER TABLE "candidate_documents" DROP CONSTRAINT "candidate_documents_organization_id_application_id_fkey",
  ADD CONSTRAINT "candidate_documents_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id")
    REFERENCES "applications"("organization_id", "id") ON DELETE SET NULL ("application_id") ON UPDATE CASCADE;

COMMIT;
