-- Candidate privacy and retention (decisions of 16 Nov 2026).
--
--   1. Organisation settings for the candidate privacy notice: the name it is given in, the contact for privacy
--      requests and complaints, and how long candidates who were not hired are kept (default 12 months).
--   2. Applicants confirm they are at least 18 (no date of birth is collected); the moment is recorded.
--   3. A public application no longer stores the applicant's IP address or browser in the audit log.
--   4. Removing a candidate: ONE function deletes or anonymises everything personal about that person in the
--      caller's organisation, keeps the applications' stage history and dates (with no personal data) so counts
--      stay right, and records the removal. Super Admins and HR Managers may do it (permission candidate:delete).
--   5. HR Managers get candidate:delete.
-- No existing data is changed by this migration (the new columns start empty or at their defaults).
BEGIN;

-- ---------------------------------------------------------------------------
-- 1-2. New columns
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations"
  ADD COLUMN "privacy_notice_name" TEXT,
  ADD COLUMN "privacy_contact_email" TEXT,
  ADD COLUMN "candidate_retention_months" INTEGER NOT NULL DEFAULT 12,
  ADD CONSTRAINT "organizations_candidate_retention_months" CHECK ("candidate_retention_months" BETWEEN 1 AND 120),
  ADD CONSTRAINT "organizations_privacy_notice_name_length" CHECK ("privacy_notice_name" IS NULL OR length(btrim("privacy_notice_name")) BETWEEN 2 AND 160),
  ADD CONSTRAINT "organizations_privacy_contact_email" CHECK ("privacy_contact_email" IS NULL OR ("privacy_contact_email" = lower("privacy_contact_email") AND "privacy_contact_email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length("privacy_contact_email") <= 254));

-- When the applicant (or, for an application entered by HR, the candidate through HR) confirmed being at least 18.
ALTER TABLE "applications" ADD COLUMN "age_confirmed_at" TIMESTAMPTZ(6);

-- A removed candidate's record stays (its applications keep their stage history for counts) but is marked.
ALTER TABLE "organization_candidates" ADD COLUMN "removed_at" TIMESTAMPTZ(6);
CREATE INDEX "organization_candidates_organization_id_removed_at_idx" ON "organization_candidates"("organization_id", "removed_at");

-- ---------------------------------------------------------------------------
-- 3. Public application: age confirmation required; no IP address or browser stored
-- ---------------------------------------------------------------------------
DROP FUNCTION "app_submit_public_application"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[], TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT);

CREATE FUNCTION "app_submit_public_application"(
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
  FROM "app_candidate_profile_internal"(p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url,
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

-- ---------------------------------------------------------------------------
-- What the public careers pages may know about an organisation: now including its privacy-notice details
-- ---------------------------------------------------------------------------
DROP FUNCTION "app_public_organization"(TEXT);
CREATE FUNCTION "app_public_organization"(p_slug TEXT)
RETURNS TABLE ("id" UUID, "name" TEXT, "slug" TEXT, "timezone" TEXT,
               "privacy_notice_name" TEXT, "privacy_contact_email" TEXT, "candidate_retention_months" INTEGER) AS $$
  SELECT o."id", o."name", o."slug", o."timezone", o."privacy_notice_name", o."privacy_contact_email", o."candidate_retention_months"
  FROM "organizations" o
  WHERE o."slug" = p_slug AND o."status" = 'ACTIVE' AND "app_mode"() = 'public_apply';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. Removing a candidate
-- ---------------------------------------------------------------------------
-- Stage history stays append-only. The one change now allowed is clearing a row's free-text "reason" (HR's own
-- words, which can be personal) to empty; everything else about the row still cannot change. Only the owner
-- account can update this table at all (the app's account has no UPDATE right on it), i.e. only the removal
-- function below.
CREATE OR REPLACE FUNCTION "block_history_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'changed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id')
     AND NOT (NEW."reason" IS NULL AND (to_jsonb(NEW) - 'changed_by_id' - 'reason') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id' - 'reason')) THEN
    RAISE EXCEPTION 'application_status_history is append-only: rows cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Removes everything personal about one candidate in the CALLER'S organisation (identity from the live session).
-- Refused while any of the candidate's applications is still open or ended in a hire: close it (reject or
-- withdraw) first. Returns the storage keys of the files to delete from disk (done by the app after commit).
--   * Deleted: HR notes on the candidate and on their applications; education, experience and skills.
--   * Cleared: the details submitted with each application, its source, rejection reason, and stage-change reasons.
--   * Files: marked deleted, original file name removed; the files themselves are deleted by the caller.
--   * The person's profile: anonymised in place when no other organisation has this person; otherwise this
--     organisation's record is moved to a new, anonymous profile and the other organisation's data is untouched.
--     Either way nothing here links to the real person any more, and they can apply again as someone new.
--   * Kept: the application rows (reference, job, stage, dates) and their stage history, without personal data.
CREATE FUNCTION "app_remove_candidate"(p_organization_candidate_id UUID, p_now TIMESTAMPTZ)
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
    INSERT INTO "candidate_profiles" ("id", "email", "full_name", "anonymized_at", "created_at", "updated_at")
    VALUES (v_target, 'removed-' || v_target || '@removed.invalid', 'Removed candidate', p_now, p_now, p_now);
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

  -- A record of the removal, with no personal data.
  INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "metadata", "created_at")
  VALUES (gen_random_uuid(), v_org, v_actor, 'candidate.removed', 'organization_candidate', v_oc."id"::TEXT,
      jsonb_build_object('applicationsKept', cardinality(v_apps), 'filesDeleted', cardinality(v_keys), 'profile', v_profile),
      p_now);

  RETURN QUERY SELECT v_keys, cardinality(v_apps), cardinality(v_keys), v_profile;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 5. HR Managers may remove candidates too
-- ---------------------------------------------------------------------------
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" = 'HR_MANAGER' AND p."key" = 'candidate:delete'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Execution rights (owner's-rights functions are never open to everyone)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "app_submit_public_application"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[], TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_public_organization"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_remove_candidate"(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_submit_public_application"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[], TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INT, TEXT, BOOLEAN) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_public_organization"(TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_remove_candidate"(UUID, TIMESTAMPTZ) TO hr_runtime;

COMMIT;
