-- Links to a candidate's files and sign-in links stay inside one organisation (SaaS tenant isolation, 20 Nov 2026).
--
-- Follow-up to 20261118020000_candidate_profiles_per_organization. A few older links still used a key on the
-- document's (or profile's) id alone, so a row of organisation A could point at organisation B's file:
--   - form answers, offer letters and onboarding documents (document_id / offer_letter_id),
--   - the files an application shares (application_documents.document_id; until now a trigger was the only guard),
--   - candidate sign-in links (candidate_login_tokens), which had no organisation at all.
-- Each now uses a two-column key (organisation, id), so such a link is refused by the database itself. Deleting a
-- file clears only the link column, never the organisation (PostgreSQL 15+ column list; Prisma still sees
-- "SET NULL"). Existing rows are not changed; if any of them already crosses organisations, nothing is changed and
-- the migration stops with a count.
BEGIN;

DO $$
DECLARE
  n INTEGER;
  problems TEXT := '';
BEGIN
  SELECT count(*) INTO n FROM "application_documents" x JOIN "candidate_documents" d ON d."id" = x."document_id" WHERE d."organization_id" <> x."organization_id";
  IF n > 0 THEN problems := problems || format(' %s shared application file(s);', n); END IF;
  SELECT count(*) INTO n FROM "form_answers" x JOIN "candidate_documents" d ON d."id" = x."document_id" WHERE d."organization_id" <> x."organization_id";
  IF n > 0 THEN problems := problems || format(' %s form answer file(s);', n); END IF;
  SELECT count(*) INTO n FROM "offers" x JOIN "candidate_documents" d ON d."id" = x."offer_letter_id" WHERE d."organization_id" <> x."organization_id";
  IF n > 0 THEN problems := problems || format(' %s offer letter(s);', n); END IF;
  SELECT count(*) INTO n FROM "onboarding_documents" x JOIN "candidate_documents" d ON d."id" = x."document_id" WHERE d."organization_id" <> x."organization_id";
  IF n > 0 THEN problems := problems || format(' %s onboarding document(s);', n); END IF;
  SELECT count(*) INTO n FROM "candidate_login_tokens" t
  JOIN "candidate_profiles" cp ON cp."id" = t."candidate_id" JOIN "applications" a ON a."id" = t."application_id"
  WHERE cp."organization_id" <> a."organization_id";
  IF n > 0 THEN problems := problems || format(' %s sign-in link(s) tie one organisation''s candidate to another''s application;', n); END IF;
  IF problems <> '' THEN
    RAISE EXCEPTION 'links cross organisations; nothing was changed:%', problems USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "candidate_documents_organization_id_id_key" ON "candidate_documents"("organization_id", "id");

ALTER TABLE "application_documents" DROP CONSTRAINT "application_documents_document_id_fkey",
  ADD CONSTRAINT "application_documents_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "candidate_documents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "form_answers" DROP CONSTRAINT "form_answers_document_id_fkey",
  ADD CONSTRAINT "form_answers_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "candidate_documents"("organization_id", "id") ON DELETE SET NULL ("document_id") ON UPDATE CASCADE;
ALTER TABLE "offers" DROP CONSTRAINT "offers_offer_letter_id_fkey",
  ADD CONSTRAINT "offers_organization_id_offer_letter_id_fkey" FOREIGN KEY ("organization_id", "offer_letter_id")
    REFERENCES "candidate_documents"("organization_id", "id") ON DELETE SET NULL ("offer_letter_id") ON UPDATE CASCADE;
ALTER TABLE "onboarding_documents" DROP CONSTRAINT "onboarding_documents_document_id_fkey",
  ADD CONSTRAINT "onboarding_documents_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "candidate_documents"("organization_id", "id") ON DELETE SET NULL ("document_id") ON UPDATE CASCADE;

-- Sign-in links: the organisation comes from the linked profile or application (both belong to one organisation).
ALTER TABLE "candidate_login_tokens" ADD COLUMN "organization_id" UUID;
UPDATE "candidate_login_tokens" t SET "organization_id" = COALESCE(
  (SELECT cp."organization_id" FROM "candidate_profiles" cp WHERE cp."id" = t."candidate_id"),
  (SELECT a."organization_id" FROM "applications" a WHERE a."id" = t."application_id"));
ALTER TABLE "candidate_login_tokens" DROP CONSTRAINT "candidate_login_tokens_candidate_id_fkey",
  DROP CONSTRAINT "candidate_login_tokens_application_id_fkey",
  ADD CONSTRAINT "candidate_login_tokens_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_login_tokens_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE SET NULL ("candidate_id") ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_login_tokens_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id")
    REFERENCES "applications"("organization_id", "id") ON DELETE SET NULL ("application_id") ON UPDATE CASCADE,
  -- A two-column key is not checked while one column is empty: a link to a candidate or an application needs its
  -- organisation.
  ADD CONSTRAINT "candidate_login_tokens_link_needs_org" CHECK ("organization_id" IS NOT NULL OR ("candidate_id" IS NULL AND "application_id" IS NULL));
CREATE INDEX "candidate_login_tokens_organization_id_idx" ON "candidate_login_tokens"("organization_id");

COMMIT;
