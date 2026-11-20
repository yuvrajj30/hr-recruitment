-- Fixes from the independent review of 20261120010000_retention_review_fixes (20 Nov 2026).
--
-- 1. Public application: a removal committing at exactly the wrong moment could leave no profile id (the profile
--    function's insert hit the old email, its look-up then missed the renamed one); that pass is now retried.
-- 2. The rule refusing applications on removed records now locks the record (FOR SHARE) before reading it, so an
--    application entered by HR during an in-flight removal either waits and is refused, or makes the removal wait
--    and then refuse (the person has an open application again).
-- 3. Retention grace: lengthening the period again within the 14 days, but still below the previous period, no
--    longer ends the grace early (e.g. 24 -> 12 -> 13 keeps 24 for the rest of the 14 days).
-- 4. app_remove_due_candidates takes an optional clock for tests; it may only be moved back (never later than the
--    database clock), so it can never make more people due. Same rules otherwise.
BEGIN;

-- 1.
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
    v_oc := NULL;
    SELECT f."id", f."created" INTO v_profile, v_created
    FROM "app_candidate_profile_internal"(v_org, p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url,
                                           p_education, p_experience, p_skills) f;
    -- A removal that commits between the profile function's insert and its look-up leaves no profile id: try again.
    CONTINUE WHEN v_profile IS NULL;

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

-- 2.
CREATE OR REPLACE FUNCTION "guard_application_candidate_removed"() RETURNS trigger AS $$
DECLARE
  v_removed TIMESTAMPTZ;
BEGIN
  SELECT oc."removed_at" INTO v_removed FROM "organization_candidates" oc WHERE oc."id" = NEW."organization_candidate_id" FOR SHARE;
  IF FOUND AND v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW; -- an unknown record is refused by its foreign key
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- 3.
CREATE OR REPLACE FUNCTION "note_retention_change"() RETURNS trigger AS $$
DECLARE
  v_in_grace BOOLEAN := OLD."candidate_retention_shortened_at" > clock_timestamp() - INTERVAL '14 days';
BEGIN
  IF NEW."candidate_retention_months" < OLD."candidate_retention_months" THEN
    NEW."candidate_retention_previous_months" := GREATEST(OLD."candidate_retention_months",
      CASE WHEN v_in_grace THEN COALESCE(OLD."candidate_retention_previous_months", 0) ELSE 0 END);
    NEW."candidate_retention_shortened_at" := clock_timestamp();
  ELSIF NEW."candidate_retention_months" > OLD."candidate_retention_months"
        AND NOT (v_in_grace AND NEW."candidate_retention_months" < COALESCE(OLD."candidate_retention_previous_months", 0)) THEN
    -- Lengthened to at least the previous period (or no grace running): nothing to protect any more.
    NEW."candidate_retention_previous_months" := NULL;
    NEW."candidate_retention_shortened_at" := NULL;
  ELSE
    -- Unchanged, or lengthened but still below the protected previous period: keep the grace as it is.
    NEW."candidate_retention_previous_months" := OLD."candidate_retention_previous_months";
    NEW."candidate_retention_shortened_at" := OLD."candidate_retention_shortened_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

-- 4.
DROP FUNCTION "app_remove_due_candidates"(INTEGER, UUID);
CREATE FUNCTION "app_remove_due_candidates"(p_limit INTEGER, p_org UUID, p_now TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE ("organization_id" UUID, "organization_candidate_id" UUID, "storage_keys" TEXT[], "failed" BOOLEAN) AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_done INT := 0;
  v_tries INT := 0;
  r RECORD;
  k TEXT[];
BEGIN
  -- p_now (tests) may only move the clock BACK: an earlier "now" can only make fewer people due.
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 OR v_now > now() THEN
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
REVOKE ALL ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID, TIMESTAMPTZ) TO hr_runtime;

COMMIT;
