-- Fixes from the independent pre-production review of 20261120000000_shared_limits_and_retention (20 Nov 2026).
--
-- 1. Retention cutoff in UTC whatever the connection's time zone (the month arithmetic of a timestamptz follows
--    the session time zone; a non-UTC session could have removed someone up to a day early).
-- 2. One failing candidate no longer rolls back the whole retention batch or stops retention for good: each
--    removal is its own subtransaction; a failure is skipped, reported (no personal data) and retried next run.
-- 3. Shortening an organisation's retention period takes effect for the automatic job only after 14 days (until
--    then the longer, previous period applies), so a typo cannot remove people overnight. Manual removal is
--    unaffected.
-- 4. Public application limits per organisation: the "address unknown" and per-email counts are kept per
--    organisation (taken from the session, not from the app), so traffic or abuse against one company cannot
--    block applications to another. The per-address count stays platform-wide.
-- 5. An application can never be attached to a removed candidate record: the public application locks the
--    record and skips a removed one, and a database rule refuses any new application on a removed record.
BEGIN;

-- ---------------------------------------------------------------------------
-- 3. Shortened retention: remember the previous period for 14 days
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ADD COLUMN "candidate_retention_previous_months" INTEGER,
  ADD COLUMN "candidate_retention_shortened_at" TIMESTAMPTZ(6);

-- Maintained only here, from the old and new period: a direct write to the two columns is ignored.
CREATE FUNCTION "note_retention_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."candidate_retention_months" < OLD."candidate_retention_months" THEN
    NEW."candidate_retention_previous_months" := GREATEST(OLD."candidate_retention_months",
      CASE WHEN OLD."candidate_retention_shortened_at" > clock_timestamp() - INTERVAL '14 days'
           THEN COALESCE(OLD."candidate_retention_previous_months", 0) ELSE 0 END);
    NEW."candidate_retention_shortened_at" := clock_timestamp();
  ELSIF NEW."candidate_retention_months" > OLD."candidate_retention_months" THEN
    NEW."candidate_retention_previous_months" := NULL;
    NEW."candidate_retention_shortened_at" := NULL;
  ELSE
    NEW."candidate_retention_previous_months" := OLD."candidate_retention_previous_months";
    NEW."candidate_retention_shortened_at" := OLD."candidate_retention_shortened_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "organizations_note_retention_change" BEFORE UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION "note_retention_change"();

-- ---------------------------------------------------------------------------
-- 1-3. The retention job's selection and batch
-- ---------------------------------------------------------------------------
DROP FUNCTION "app_remove_due_candidates"(INTEGER, UUID);

-- Removes up to p_limit candidates who are due NOW (same rule as listDueForRemoval in privacy.ts; cutoff in UTC;
-- during the 14 days after a shortening the longer previous period applies). Oldest first. Each removal is its
-- own subtransaction: a failure is returned with failed = true and nothing of that candidate changes; it does not
-- count against p_limit, and the work on failing candidates is capped (p_limit * 5 attempts per call).
CREATE FUNCTION "app_remove_due_candidates"(p_limit INTEGER, p_org UUID)
RETURNS TABLE ("organization_id" UUID, "organization_candidate_id" UUID, "storage_keys" TEXT[], "failed" BOOLEAN) AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_done INT := 0;
  v_tries INT := 0;
  r RECORD;
  k TEXT[];
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    SELECT oc."id", oc."organization_id"
    FROM "organization_candidates" oc
    JOIN "organizations" o ON o."id" = oc."organization_id"
    JOIN "applications" a ON a."organization_candidate_id" = oc."id" AND a."organization_id" = oc."organization_id"
    WHERE oc."removed_at" IS NULL AND (p_org IS NULL OR oc."organization_id" = p_org)
    GROUP BY oc."id", oc."organization_id", o."candidate_retention_months", o."candidate_retention_previous_months", o."candidate_retention_shortened_at"
    HAVING bool_and(a."stage" IN ('REJECTED', 'WITHDRAWN', 'OFFER_DECLINED'))
       AND max(a."stage_changed_at") < ((v_now AT TIME ZONE 'UTC') - make_interval(months => CASE
             WHEN o."candidate_retention_shortened_at" > v_now - INTERVAL '14 days'
             THEN GREATEST(o."candidate_retention_months", COALESCE(o."candidate_retention_previous_months", 0))
             ELSE o."candidate_retention_months" END)) AT TIME ZONE 'UTC'
    ORDER BY max(a."stage_changed_at"), oc."id"
  LOOP
    EXIT WHEN v_done >= p_limit OR v_tries >= p_limit * 5;
    v_tries := v_tries + 1;
    "organization_id" := r."organization_id";
    "organization_candidate_id" := r."id";
    BEGIN
      SELECT c."storage_keys" INTO k FROM "app_remove_candidate_core"(r."organization_id", NULL, r."id", v_now, 'retention') c;
      v_done := v_done + 1;
      "storage_keys" := k;
      "failed" := false;
    EXCEPTION WHEN OTHERS THEN
      -- Only the record id and the error code: the message could echo personal data.
      RAISE WARNING 'retention skipped organization candidate % (sqlstate %)', r."id", SQLSTATE;
      "storage_keys" := NULL;
      "failed" := true;
    END;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. Public application limits per organisation
-- ---------------------------------------------------------------------------
-- Same signature and limits as before. The organisation is the one the request was narrowed to
-- (app_public_org_id(), from the session); the "address unknown" and per-email keys are derived per organisation
-- in the database. The per-address key stays platform-wide (one address applying everywhere is still one address).
CREATE OR REPLACE FUNCTION "app_public_apply_allowed"(p_address_hash TEXT, p_email_hash TEXT) RETURNS BOOLEAN AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_org UUID := "app_public_org_id"();
  v_bucket TEXT := CASE WHEN p_address_hash IS NULL THEN 'unknown_address' ELSE 'address' END;
  v_address TEXT;
  v_email TEXT;
  v_address_limit INT := CASE WHEN p_address_hash IS NULL THEN 30 ELSE 5 END;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'public_apply' OR v_org IS NULL OR p_email_hash IS NULL
     OR p_email_hash !~ '^[0-9a-f]{64}$' OR (p_address_hash IS NOT NULL AND p_address_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_address := COALESCE(p_address_hash, encode(sha256(convert_to('unknown-address:' || v_org::TEXT, 'UTF8')), 'hex'));
  v_email := encode(sha256(convert_to('email:' || v_org::TEXT || ':' || p_email_hash, 'UTF8')), 'hex');
  -- Always the address first, then the email: two submissions never wait on each other in opposite order.
  PERFORM pg_advisory_xact_lock(hashtextextended('apply:' || v_bucket || ':' || v_address, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('apply:email:' || v_email, 0));
  DELETE FROM "public_apply_rate_events" WHERE "created_at" < v_now - INTERVAL '1 hour';
  IF (SELECT count(*) FROM "public_apply_rate_events" WHERE "bucket" = v_bucket AND "key_hash" = v_address AND "created_at" > v_now - INTERVAL '10 minutes') >= v_address_limit
     OR (SELECT count(*) FROM "public_apply_rate_events" WHERE "bucket" = 'email' AND "key_hash" = v_email AND "created_at" > v_now - INTERVAL '1 hour') >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO "public_apply_rate_events" ("bucket", "key_hash", "created_at") VALUES (v_bucket, v_address, v_now), ('email', v_email, v_now);
  RETURN true;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 5. No application on a removed candidate record
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
  v_try INT;
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

  -- The organisation's record of this person, locked (FOR SHARE) and only if it is not removed. A removal of
  -- the same person running at this moment either finishes first (its record is then skipped: the email is free
  -- again and a fresh profile and record are made on the second pass) or waits for this application and then
  -- refuses, because the person has an open application again. Never an application on a removed record.
  FOR v_try IN 1..2 LOOP
    SELECT f."id", f."created" INTO v_profile, v_created
    FROM "app_candidate_profile_internal"(v_org, p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url,
                                           p_education, p_experience, p_skills) f;

    INSERT INTO "organization_candidates" ("id", "organization_id", "candidate_id", "first_seen_at", "updated_at")
    VALUES (gen_random_uuid(), v_org, v_profile, p_now, p_now)
    ON CONFLICT ("organization_id", "candidate_id") DO NOTHING;
    SELECT oc."id" INTO v_oc FROM "organization_candidates" oc
    WHERE oc."organization_id" = v_org AND oc."candidate_id" = v_profile AND oc."removed_at" IS NULL
    FOR SHARE;
    EXIT WHEN v_oc IS NOT NULL;
  END LOOP;
  IF v_oc IS NULL THEN
    RAISE EXCEPTION 'try_again' USING ERRCODE = 'P0001';
  END IF;

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

-- Belt and braces for every way an application is created (public form, HR entry, future code).
CREATE FUNCTION "guard_application_candidate_removed"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "organization_candidates" oc WHERE oc."id" = NEW."organization_candidate_id" AND oc."removed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "applications_candidate_not_removed" BEFORE INSERT OR UPDATE OF "organization_candidate_id" ON "applications"
  FOR EACH ROW EXECUTE FUNCTION "guard_application_candidate_removed"();

-- ---------------------------------------------------------------------------
-- Execution rights
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID) TO hr_runtime;
REVOKE ALL ON FUNCTION "note_retention_change"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_application_candidate_removed"() FROM PUBLIC;

COMMIT;
