-- Candidate profiles belong to ONE organisation (SaaS tenant isolation, 18 Nov 2026).
--
-- Until now a candidate profile (name, email, phone, city, links, education, experience, skills) was shared by
-- every organisation that received an application from the same email address. A second company was linked to
-- the profile the first company's application had created, so it could read what the person told the first
-- company, and it learned that the person had applied elsewhere. From now on:
--
--   1. Every candidate profile, and its education, experience and skills, carries organization_id. One profile
--      per organisation and normalised email (trimmed, lower-case): repeat applications to the same
--      organisation still find the same profile; another organisation gets its own, separate profile.
--   2. Existing shared profiles are split. EVERY organisation on a shared profile ends up with a profile built
--      only from what was submitted to IT (its most recent application's stored details), never a copy of
--      another organisation's data: the organisation that saw the person first keeps the profile's id, but its
--      details, education, experience and skills are rebuilt the same way (which organisation's request actually
--      created the profile is not recorded reliably). The same rebuild applies to a profile that is older than
--      its only organisation record: it was created for an organisation that has since removed the person (the
--      old removal moved that organisation away and left its details behind). Each organisation's own record,
--      applications, notes, interviews, feedback, decisions and private files stay with it; documents move to
--      that organisation's new profile. A profile that only ever had one organisation is not changed.
--   3. Row-level security on candidate profiles, education, experience and skills compares organization_id
--      directly (the old per-row function looked up the session again for every row of every organisation,
--      which made candidate lists slow and grew with the platform-wide number of candidates).
--   4. Composite keys make a cross-organisation link impossible: an organisation's candidate record, documents,
--      education, experience and skills can only point at a profile of the same organisation.
--
-- Data that cannot be assigned safely is NOT guessed: the migration stops at the start, before changing anything,
-- and names what needs a decision (profiles with no organisation, documents without or with the wrong
-- organisation, candidate accounts or sign-in tokens on a profile that is rebuilt, or an organisation whose
-- profile must be rebuilt but that has no submitted details of its own).
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Refuse, before any change, when something cannot be assigned safely
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n INTEGER;
  problems TEXT := '';
BEGIN
  SELECT count(*) INTO n FROM "candidate_profiles" cp
  WHERE NOT EXISTS (SELECT 1 FROM "organization_candidates" oc WHERE oc."candidate_id" = cp."id");
  IF n > 0 THEN problems := problems || format(' %s candidate profile(s) belong to no organisation;', n); END IF;

  SELECT count(*) INTO n FROM "candidate_documents" WHERE "organization_id" IS NULL;
  IF n > 0 THEN problems := problems || format(' %s candidate document(s) have no organisation;', n); END IF;

  SELECT count(*) INTO n FROM "candidate_documents" d
  WHERE d."organization_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "organization_candidates" oc WHERE oc."candidate_id" = d."candidate_id" AND oc."organization_id" = d."organization_id");
  IF n > 0 THEN problems := problems || format(' %s candidate document(s) belong to an organisation that has no record of that candidate;', n); END IF;

  SELECT count(*) INTO n FROM "application_documents" ad JOIN "candidate_documents" d ON d."id" = ad."document_id"
  WHERE d."organization_id" IS DISTINCT FROM ad."organization_id";
  IF n > 0 THEN problems := problems || format(' %s document link(s) cross organisations;', n); END IF;

  -- Which records get a profile rebuilt from their own submitted details: every record on a shared profile, and
  -- the only record of a profile created more than 2 seconds before it (a profile and the record of the
  -- organisation whose application created it are written in the same request).
  CREATE TEMP TABLE "_cp_rebuild" ON COMMIT DROP AS
  SELECT oc."id" AS oc_id, oc."candidate_id", oc."removed_at"
  FROM "organization_candidates" oc JOIN "candidate_profiles" cp ON cp."id" = oc."candidate_id"
  WHERE (SELECT count(*) FROM "organization_candidates" o WHERE o."candidate_id" = oc."candidate_id") > 1
     OR cp."created_at" < oc."created_at" - INTERVAL '2 seconds';

  -- Candidate sign-in (accounts, sessions, sign-in links) is per person, not per organisation: on a profile that
  -- is rebuilt there is no safe owner to give it to.
  SELECT count(*) INTO n FROM "candidate_accounts" ca WHERE ca."candidate_id" IN (SELECT "candidate_id" FROM "_cp_rebuild");
  IF n > 0 THEN problems := problems || format(' %s candidate account(s) belong to a profile that is shared or was created for another organisation;', n); END IF;

  SELECT count(*) INTO n FROM "candidate_login_tokens" t WHERE t."candidate_id" IN (SELECT "candidate_id" FROM "_cp_rebuild");
  IF n > 0 THEN problems := problems || format(' %s candidate sign-in link(s) belong to a profile that is shared or was created for another organisation;', n); END IF;

  -- A rebuilt profile comes from what was submitted to that organisation; without that there is nothing of its
  -- own to build from (unless its record was already removed, which needs no personal data).
  SELECT count(*) INTO n FROM "_cp_rebuild" r
  WHERE r."removed_at" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "applications" a WHERE a."organization_candidate_id" = r.oc_id AND a."profile_snapshot" IS NOT NULL);
  IF n > 0 THEN problems := problems || format(' %s organisation record(s) need a profile of their own but have no submitted details to build it from;', n); END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION 'candidate profiles cannot be split safely; nothing was changed:%', problems USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------
ALTER TABLE "candidate_profiles" ADD COLUMN "organization_id" UUID;
ALTER TABLE "candidate_educations" ADD COLUMN "organization_id" UUID;
ALTER TABLE "candidate_experiences" ADD COLUMN "organization_id" UUID;
ALTER TABLE "candidate_skills" ADD COLUMN "organization_id" UUID;

-- ---------------------------------------------------------------------------
-- 2. Split shared profiles
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_cp_links" ON COMMIT DROP AS
SELECT oc."id" AS oc_id, oc."organization_id", oc."candidate_id", oc."removed_at",
       row_number() OVER (PARTITION BY oc."candidate_id" ORDER BY oc."first_seen_at", oc."created_at", oc."id") AS rn
FROM "organization_candidates" oc;

-- The organisation that saw the person first keeps the existing profile.
UPDATE "candidate_profiles" cp SET "organization_id" = l."organization_id"
FROM "_cp_links" l WHERE l."candidate_id" = cp."id" AND l.rn = 1;

-- From here on an email is unique per organisation, not across all of them (the split below creates the same
-- email again in other organisations).
DROP INDEX "candidate_profiles_email_key";
CREATE UNIQUE INDEX "candidate_profiles_organization_id_email_key" ON "candidate_profiles"("organization_id", "email");

-- Every record to rebuild (see the safety stop above) gets a profile from its own most recent submitted details:
-- a later organisation a NEW profile, the first organisation the existing profile (same id) with its details,
-- education, experience and skills replaced. A removed record's profile holds no personal data.
CREATE TEMP TABLE "_cp_split" ON COMMIT DROP AS
SELECT l.oc_id, l."organization_id", l."candidate_id" AS old_id,
       CASE WHEN l.rn = 1 THEN l."candidate_id" ELSE gen_random_uuid() END AS new_id, l."removed_at",
       (SELECT cp."email" FROM "candidate_profiles" cp WHERE cp."id" = l."candidate_id") AS old_email,
       (SELECT a."profile_snapshot" FROM "applications" a
        WHERE a."organization_candidate_id" = l.oc_id AND a."profile_snapshot" IS NOT NULL
        ORDER BY a."applied_at" DESC, a."id" DESC LIMIT 1) AS snap
FROM "_cp_links" l WHERE l.oc_id IN (SELECT oc_id FROM "_cp_rebuild");

-- The first organisation's existing profile: details replaced, old education, experience and skills removed
-- (they are rebuilt below like everyone else's).
UPDATE "candidate_profiles" cp SET
  "email" = CASE WHEN s."removed_at" IS NOT NULL THEN 'removed-' || cp."id" || '@removed.invalid' ELSE cp."email" END,
  "full_name" = CASE WHEN s."removed_at" IS NOT NULL THEN 'Removed candidate' ELSE COALESCE(NULLIF(btrim(s.snap->>'fullName'), ''), 'Name not given') END,
  "phone" = CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'phone'), '') END,
  "city" = CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'city'), '') END,
  "linkedin_url" = CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'linkedinUrl'), '') END,
  "portfolio_url" = CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'portfolioUrl'), '') END,
  "email_verified_at" = NULL,
  "anonymized_at" = CASE WHEN s."removed_at" IS NOT NULL THEN COALESCE(cp."anonymized_at", s."removed_at") ELSE cp."anonymized_at" END,
  "updated_at" = CURRENT_TIMESTAMP
FROM "_cp_split" s WHERE s.new_id = s.old_id AND cp."id" = s.old_id;
DELETE FROM "candidate_educations" WHERE "candidate_id" IN (SELECT old_id FROM "_cp_split" WHERE new_id = old_id);
DELETE FROM "candidate_experiences" WHERE "candidate_id" IN (SELECT old_id FROM "_cp_split" WHERE new_id = old_id);
DELETE FROM "candidate_skills" WHERE "candidate_id" IN (SELECT old_id FROM "_cp_split" WHERE new_id = old_id);

INSERT INTO "candidate_profiles" ("id", "organization_id", "email", "full_name", "phone", "city", "linkedin_url", "portfolio_url",
                                  "anonymized_at", "created_at", "updated_at")
SELECT s.new_id, s."organization_id",
       CASE WHEN s."removed_at" IS NOT NULL THEN 'removed-' || s.new_id || '@removed.invalid' ELSE s.old_email END,
       CASE WHEN s."removed_at" IS NOT NULL THEN 'Removed candidate' ELSE COALESCE(NULLIF(btrim(s.snap->>'fullName'), ''), 'Name not given') END,
       CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'phone'), '') END,
       CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'city'), '') END,
       CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'linkedinUrl'), '') END,
       CASE WHEN s."removed_at" IS NOT NULL THEN NULL ELSE NULLIF(btrim(s.snap->>'portfolioUrl'), '') END,
       CASE WHEN s."removed_at" IS NOT NULL THEN s."removed_at" END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_cp_split" s WHERE s.new_id <> s.old_id;

INSERT INTO "candidate_educations" ("id", "candidate_id", "organization_id", "institution", "course", "degree", "graduation_year")
SELECT gen_random_uuid(), s.new_id, s."organization_id", s.snap->'education'->>'institution', s.snap->'education'->>'course',
       s.snap->'education'->>'degree', NULLIF(s.snap->'education'->>'graduationYear', '')::INT
FROM "_cp_split" s
WHERE s."removed_at" IS NULL AND jsonb_typeof(s.snap->'education') = 'object' AND NULLIF(btrim(s.snap->'education'->>'institution'), '') IS NOT NULL;

INSERT INTO "candidate_experiences" ("id", "candidate_id", "organization_id", "company", "title", "description")
SELECT gen_random_uuid(), s.new_id, s."organization_id", s.snap->'experience'->>'company', s.snap->'experience'->>'title', s.snap->'experience'->>'description'
FROM "_cp_split" s
WHERE s."removed_at" IS NULL AND jsonb_typeof(s.snap->'experience') = 'object'
  AND NULLIF(btrim(s.snap->'experience'->>'company'), '') IS NOT NULL AND NULLIF(btrim(s.snap->'experience'->>'title'), '') IS NOT NULL;

INSERT INTO "candidate_skills" ("id", "candidate_id", "organization_id", "name")
SELECT gen_random_uuid(), x.new_id, x."organization_id", x.skill
FROM (SELECT DISTINCT s.new_id, s."organization_id", lower(btrim(sk.value)) AS skill
      FROM "_cp_split" s CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.snap->'skills') = 'array' THEN s.snap->'skills' ELSE '[]'::jsonb END) sk
      WHERE s."removed_at" IS NULL) x
WHERE x.skill <> '';

-- Each later organisation's record and its private files move to its new profile.
UPDATE "organization_candidates" oc SET "candidate_id" = s.new_id FROM "_cp_split" s WHERE oc."id" = s.oc_id AND s.new_id <> s.old_id;
UPDATE "candidate_documents" d SET "candidate_id" = s.new_id
FROM "_cp_split" s WHERE d."candidate_id" = s.old_id AND d."organization_id" = s."organization_id" AND s.new_id <> s.old_id;

-- Education, experience and skills of profiles that were not rebuilt belong to the profile's only organisation.
UPDATE "candidate_educations" e SET "organization_id" = cp."organization_id" FROM "candidate_profiles" cp WHERE cp."id" = e."candidate_id" AND e."organization_id" IS NULL;
UPDATE "candidate_experiences" e SET "organization_id" = cp."organization_id" FROM "candidate_profiles" cp WHERE cp."id" = e."candidate_id" AND e."organization_id" IS NULL;
UPDATE "candidate_skills" e SET "organization_id" = cp."organization_id" FROM "candidate_profiles" cp WHERE cp."id" = e."candidate_id" AND e."organization_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Keys: one profile per organisation and email; no link can cross organisations
-- ---------------------------------------------------------------------------
ALTER TABLE "candidate_profiles" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "candidate_profiles"
  ADD CONSTRAINT "candidate_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_profiles_email_normalised" CHECK ("email" = lower(btrim("email")) AND "email" <> '');
CREATE UNIQUE INDEX "candidate_profiles_organization_id_id_key" ON "candidate_profiles"("organization_id", "id");

ALTER TABLE "candidate_educations" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "candidate_experiences" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "candidate_skills" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "candidate_educations" DROP CONSTRAINT "candidate_educations_candidate_id_fkey",
  ADD CONSTRAINT "candidate_educations_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_experiences" DROP CONSTRAINT "candidate_experiences_candidate_id_fkey",
  ADD CONSTRAINT "candidate_experiences_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_skills" DROP CONSTRAINT "candidate_skills_candidate_id_fkey",
  ADD CONSTRAINT "candidate_skills_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "candidate_educations_candidate_id_idx";
DROP INDEX "candidate_experiences_candidate_id_idx";
CREATE INDEX "candidate_educations_organization_id_candidate_id_idx" ON "candidate_educations"("organization_id", "candidate_id");
CREATE INDEX "candidate_experiences_organization_id_candidate_id_idx" ON "candidate_experiences"("organization_id", "candidate_id");
CREATE INDEX "candidate_skills_organization_id_candidate_id_idx" ON "candidate_skills"("organization_id", "candidate_id");

-- An organisation's candidate record points at a profile of the SAME organisation, and a profile has exactly
-- one organisation record.
ALTER TABLE "organization_candidates" DROP CONSTRAINT "organization_candidates_candidate_id_fkey",
  ADD CONSTRAINT "organization_candidates_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "organization_candidates_candidate_id_idx";
CREATE UNIQUE INDEX "organization_candidates_candidate_id_key" ON "organization_candidates"("candidate_id");

-- A document belongs to an organisation and to that organisation's profile of the person.
ALTER TABLE "candidate_documents" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "candidate_documents" DROP CONSTRAINT "candidate_documents_candidate_id_fkey",
  ADD CONSTRAINT "candidate_documents_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "candidate_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "candidate_documents_candidate_id_kind_idx";
CREATE INDEX "candidate_documents_organization_id_candidate_id_kind_idx" ON "candidate_documents"("organization_id", "candidate_id", "kind");

-- ---------------------------------------------------------------------------
-- 3. Row-level security: the organisation column, compared once per statement
-- ---------------------------------------------------------------------------
DROP POLICY "hr_my_candidates" ON "candidate_profiles";
DROP POLICY "hr_my_candidates" ON "candidate_educations";
DROP POLICY "hr_my_candidates" ON "candidate_experiences";
DROP POLICY "hr_my_candidates" ON "candidate_skills";
CREATE POLICY "hr_same_org" ON "candidate_profiles" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "candidate_educations" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "candidate_experiences" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "candidate_skills" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));

-- The old per-row helper is no longer used by any policy; it now answers from the profile's own column.
CREATE OR REPLACE FUNCTION "app_candidate_in_my_org"(candidate UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM "candidate_profiles" cp WHERE cp."id" = candidate AND cp."organization_id" = "app_org_id"());
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 1. Finding or creating a profile: within one organisation only
-- ---------------------------------------------------------------------------
DROP FUNCTION "app_candidate_profile_internal"(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[]);

-- Finds this organisation's profile for an email, or creates it (with education, experience and skills).
-- An existing profile is not changed: nobody has proved they own that email address, and what they typed is
-- kept with each application (its stored details). Another organisation's profiles are never looked at.
CREATE FUNCTION "app_candidate_profile_internal"(
  p_org UUID, p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT, p_linkedin_url TEXT, p_portfolio_url TEXT,
  p_education JSONB, p_experience JSONB, p_skills TEXT[]
) RETURNS TABLE ("id" UUID, "created" BOOLEAN) AS $$
DECLARE
  v_id UUID;
  v_created BOOLEAN := false;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_email IS NULL OR p_email <> lower(btrim(p_email)) OR p_email = '' THEN
    RAISE EXCEPTION 'email must be normalised' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "candidate_profiles" ("id", "organization_id", "email", "full_name", "phone", "city", "linkedin_url", "portfolio_url", "updated_at")
  VALUES (gen_random_uuid(), p_org, p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url, CURRENT_TIMESTAMP)
  ON CONFLICT ("organization_id", "email") DO NOTHING
  RETURNING "candidate_profiles"."id" INTO v_id;

  IF v_id IS NOT NULL THEN
    v_created := true;
    IF p_education IS NOT NULL THEN
      INSERT INTO "candidate_educations" ("id", "candidate_id", "organization_id", "institution", "course", "degree", "graduation_year")
      VALUES (gen_random_uuid(), v_id, p_org, p_education->>'institution', p_education->>'course', p_education->>'degree', (p_education->>'graduationYear')::INT);
    END IF;
    IF p_experience IS NOT NULL THEN
      INSERT INTO "candidate_experiences" ("id", "candidate_id", "organization_id", "company", "title", "description")
      VALUES (gen_random_uuid(), v_id, p_org, p_experience->>'company', p_experience->>'title', p_experience->>'description');
    END IF;
    INSERT INTO "candidate_skills" ("id", "candidate_id", "organization_id", "name")
    SELECT gen_random_uuid(), v_id, p_org, s FROM (SELECT DISTINCT lower(x) AS s FROM unnest(COALESCE(p_skills, ARRAY[]::TEXT[])) AS x) skills
    WHERE s <> '';
  ELSE
    SELECT cp."id" INTO v_id FROM "candidate_profiles" cp WHERE cp."organization_id" = p_org AND cp."email" = p_email;
  END IF;

  RETURN QUERY SELECT v_id, v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR entering an application by hand: the organisation is the caller's own (from the live session).
CREATE OR REPLACE FUNCTION "app_find_or_create_candidate_profile"(
  p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT, p_linkedin_url TEXT, p_portfolio_url TEXT,
  p_education JSONB, p_experience JSONB, p_skills TEXT[]
) RETURNS TABLE ("id" UUID, "created" BOOLEAN) AS $$
DECLARE
  v_org UUID := "app_org_id"();
BEGIN
  IF v_org IS NULL OR NOT "app_is_hr"() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT f."id", f."created"
  FROM "app_candidate_profile_internal"(v_org, p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url, p_education, p_experience, p_skills) f;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- The public application and candidate removal, updated for organisation-owned profiles
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app_submit_public_application"(
  p_job_id UUID, p_reference TEXT, p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT,
  p_linkedin_url TEXT, p_portfolio_url TEXT, p_education JSONB, p_experience JSONB, p_skills TEXT[],
  p_source TEXT, p_snapshot JSONB, p_privacy_notice_version TEXT, p_now TIMESTAMPTZ,
  p_resume_name TEXT, p_resume_key TEXT, p_resume_mime TEXT, p_resume_size INT, p_resume_sha256 TEXT,
  p_age_confirmed BOOLEAN
) RETURNS TABLE ("application_id" UUID, "reference_number" TEXT, "candidate_was_known" BOOLEAN) AS $$
DECLARE
  v_org UUID;
  v_profile UUID;
  v_created BOOLEAN;
  v_oc UUID;
  v_app UUID;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'public_apply' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_age_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'age_not_confirmed' USING ERRCODE = 'P0001';
  END IF;
  -- Published, public, still open (by the database's own clock), in an ACTIVE organisation, and that
  -- organisation is the one this request was narrowed to.
  SELECT j."organization_id" INTO v_org
  FROM "job_openings" j JOIN "organizations" o ON o."id" = j."organization_id"
  WHERE j."id" = p_job_id AND j."status" = 'PUBLISHED' AND j."visibility" = 'PUBLIC' AND o."status" = 'ACTIVE'
    AND (j."application_deadline" IS NULL OR j."application_deadline" > now())
    AND j."organization_id" = "app_public_org_id"()
  FOR SHARE OF j;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_closed' USING ERRCODE = 'P0001';
  END IF;

  SELECT f."id", f."created" INTO v_profile, v_created
  FROM "app_candidate_profile_internal"(v_org, p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url,
                                         p_education, p_experience, p_skills) f;

  INSERT INTO "organization_candidates" ("id", "organization_id", "candidate_id", "first_seen_at", "updated_at")
  VALUES (gen_random_uuid(), v_org, v_profile, p_now, p_now)
  ON CONFLICT ("organization_id", "candidate_id") DO NOTHING;
  SELECT oc."id" INTO v_oc FROM "organization_candidates" oc WHERE oc."organization_id" = v_org AND oc."candidate_id" = v_profile;

  IF EXISTS (SELECT 1 FROM "applications" a WHERE a."job_id" = p_job_id AND a."organization_candidate_id" = v_oc) THEN
    RAISE EXCEPTION 'duplicate_application' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "applications" ("id", "organization_id", "reference_number", "organization_candidate_id", "job_id", "stage",
      "stage_changed_at", "source", "profile_snapshot", "created_by_id", "consent_accepted_at", "privacy_notice_version",
      "age_confirmed_at", "applied_at", "created_at", "updated_at")
  VALUES (gen_random_uuid(), v_org, p_reference, v_oc, p_job_id, 'APPLIED',
      p_now, p_source, p_snapshot, NULL, p_now, p_privacy_notice_version, p_now, p_now, p_now, p_now)
  RETURNING "id" INTO v_app;

  INSERT INTO "application_status_history" ("id", "organization_id", "application_id", "from_stage", "to_stage", "changed_by_id", "created_at")
  VALUES (gen_random_uuid(), v_org, v_app, NULL, 'APPLIED', NULL, p_now);

  IF p_resume_key IS NOT NULL THEN
    INSERT INTO "candidate_documents" ("id", "candidate_id", "organization_id", "application_id", "kind", "original_name",
        "storage_key", "mime_type", "size_bytes", "sha256", "uploaded_at")
    VALUES (gen_random_uuid(), v_profile, v_org, v_app, 'RESUME', p_resume_name, p_resume_key, p_resume_mime, p_resume_size, p_resume_sha256, p_now);
  END IF;

  -- No IP address and no browser string: the applicant is not identified in the audit log.
  INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "metadata", "created_at")
  VALUES (gen_random_uuid(), v_org, NULL, 'application.submitted', 'application', v_app::TEXT,
      jsonb_build_object('reference', p_reference, 'jobId', p_job_id, 'knownCandidate', NOT v_created, 'hasResume', p_resume_key IS NOT NULL),
      p_now);

  RETURN QUERY SELECT v_app, p_reference, NOT v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- (The organisation now owns the profile, so removal always anonymises it in place. The branch for a profile
-- shared with another organisation can no longer be reached; it is kept, now stamping the organisation.)
CREATE OR REPLACE FUNCTION "app_remove_candidate"(p_organization_candidate_id UUID, p_now TIMESTAMPTZ)
RETURNS TABLE ("storage_keys" TEXT[], "applications_kept" INTEGER, "files" INTEGER, "profile" TEXT) AS $$
DECLARE
  v_org UUID := "app_org_id"();
  v_actor UUID := "app_user_id"();
  v_oc RECORD;
  v_apps UUID[];
  v_keys TEXT[];
  v_target UUID;
  v_profile TEXT;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR p_now IS NULL OR NOT EXISTS (
       SELECT 1 FROM "role_permissions" rp
       JOIN "roles" r ON r."id" = rp."role_id"
       JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE r."key" = "app_staff_role"() AND p."key" = 'candidate:delete') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT oc.* INTO v_oc FROM "organization_candidates" oc
  WHERE oc."id" = p_organization_candidate_id AND oc."organization_id" = v_org
  FOR UPDATE;
  IF NOT FOUND OR v_oc."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(a."id"), '{}') INTO v_apps FROM "applications" a
  WHERE a."organization_candidate_id" = v_oc."id" AND a."organization_id" = v_org;
  IF EXISTS (SELECT 1 FROM "applications" a WHERE a."id" = ANY(v_apps) AND a."stage" NOT IN ('REJECTED', 'WITHDRAWN', 'OFFER_DECLINED')) THEN
    RAISE EXCEPTION 'applications_open' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "organization_candidates" o WHERE o."candidate_id" = v_oc."candidate_id" AND o."id" <> v_oc."id") THEN
    -- Nobody else has this person: every file of theirs goes, and the profile itself is anonymised.
    v_target := v_oc."candidate_id";
    SELECT COALESCE(array_agg(d."storage_key"), '{}') INTO v_keys FROM "candidate_documents" d
    WHERE d."candidate_id" = v_target AND d."deleted_at" IS NULL;
    UPDATE "candidate_profiles" SET "email" = 'removed-' || "id" || '@removed.invalid', "full_name" = 'Removed candidate',
        "phone" = NULL, "city" = NULL, "linkedin_url" = NULL, "portfolio_url" = NULL, "email_verified_at" = NULL,
        "anonymized_at" = p_now, "updated_at" = p_now
    WHERE "id" = v_target;
    DELETE FROM "candidate_educations" WHERE "candidate_id" = v_target;
    DELETE FROM "candidate_experiences" WHERE "candidate_id" = v_target;
    DELETE FROM "candidate_skills" WHERE "candidate_id" = v_target;
    DELETE FROM "candidate_accounts" WHERE "candidate_id" = v_target;
    v_profile := 'anonymised';
  ELSE
    -- Another organisation still has this person: only this organisation's files go, and this organisation's
    -- record (and its files) move to a new anonymous profile. The other organisation's data is untouched.
    SELECT COALESCE(array_agg(d."storage_key"), '{}') INTO v_keys FROM "candidate_documents" d
    WHERE d."candidate_id" = v_oc."candidate_id" AND d."organization_id" = v_org AND d."deleted_at" IS NULL;
    v_target := gen_random_uuid();
    INSERT INTO "candidate_profiles" ("id", "organization_id", "email", "full_name", "anonymized_at", "created_at", "updated_at")
    VALUES (v_target, v_org, 'removed-' || v_target || '@removed.invalid', 'Removed candidate', p_now, p_now, p_now);
    UPDATE "candidate_documents" SET "candidate_id" = v_target
    WHERE "candidate_id" = v_oc."candidate_id" AND "organization_id" = v_org;
    UPDATE "organization_candidates" SET "candidate_id" = v_target WHERE "id" = v_oc."id";
    v_profile := 'detached';
  END IF;

  UPDATE "candidate_documents" SET "deleted_at" = p_now, "original_name" = 'removed', "sha256" = ''
  WHERE "storage_key" = ANY(v_keys);

  UPDATE "applications" SET "profile_snapshot" = NULL, "source" = NULL, "rejection_reason" = NULL, "status_token_hash" = NULL, "updated_at" = p_now
  WHERE "id" = ANY(v_apps);
  DELETE FROM "application_notes" WHERE "application_id" = ANY(v_apps);
  UPDATE "application_status_history" SET "reason" = NULL WHERE "application_id" = ANY(v_apps) AND "reason" IS NOT NULL;

  UPDATE "organization_candidates" SET "notes" = NULL, "tags" = '{}', "claimed_employee_code" = NULL,
      "removed_at" = p_now, "updated_at" = p_now
  WHERE "id" = v_oc."id";

  -- Interviews and feedback: what HR and interviewers wrote about the person goes; ratings, recommendations,
  -- outcomes, rounds and dates stay (no personal data), so the numbers stay right.
  -- Still-scheduled interviews are cancelled; the place and meeting link are replaced (the kind of interview
  -- still says where it was held, which the table's rules require).
  UPDATE "interviews" SET "round_name" = NULL, "instructions" = NULL,
      "status" = CASE WHEN "status" = 'SCHEDULED' THEN 'CANCELLED'::"InterviewStatus" ELSE "status" END,
      "cancel_reason" = CASE WHEN "status" = 'SCHEDULED' OR "cancel_reason" IS NOT NULL THEN 'Removed with the candidate''s data' END,
      "location" = CASE WHEN "location" IS NULL THEN NULL ELSE 'Removed' END,
      "meeting_link" = CASE WHEN "meeting_link" IS NULL THEN NULL ELSE 'https://removed.invalid' END,
      "updated_at" = p_now
  WHERE "application_id" = ANY(v_apps) AND "organization_id" = v_org;
  UPDATE "interview_feedback" f SET "strengths" = NULL, "weaknesses" = NULL, "notes" = NULL, "updated_at" = p_now
  FROM "interview_participants" ip JOIN "interviews" i ON i."id" = ip."interview_id"
  WHERE f."participant_id" = ip."id" AND i."application_id" = ANY(v_apps) AND f."organization_id" = v_org;
  UPDATE "hiring_decisions" SET "rationale" = NULL WHERE "application_id" = ANY(v_apps) AND "organization_id" = v_org;
  -- A record of the removal, with no personal data.
  INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "metadata", "created_at")
  VALUES (gen_random_uuid(), v_org, v_actor, 'candidate.removed', 'organization_candidate', v_oc."id"::TEXT,
      jsonb_build_object('applicationsKept', cardinality(v_apps), 'filesDeleted', cardinality(v_keys), 'profile', v_profile),
      p_now);

  RETURN QUERY SELECT v_keys, cardinality(v_apps), cardinality(v_keys), v_profile;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- Execution rights (owner's-rights functions are never open to everyone)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "app_candidate_profile_internal"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[]) FROM PUBLIC;

COMMIT;
