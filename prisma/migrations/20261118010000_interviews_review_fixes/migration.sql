-- Interviews and feedback: fixes from the independent review (18 Nov 2026). Applied after
-- 20261118000000_interviews_feedback; that migration is left exactly as applied.
--
--   1. Who interviews is fixed once the interview has started: from then on interviewers can no longer be
--      added or removed. (Before this, someone could step off the interview, read colleagues' submitted
--      feedback, step back on and then write their own; and a removal racing a submission could delete it.)
--   2. A started interview can no longer be moved to another time (cancel it and schedule a new round).
--   3. After a candidate's data is removed, the database refuses any new interview, interviewer, feedback or
--      decision text about them; the removal also cancels their still-scheduled interviews and clears the
--      interview place and meeting link.
--   4. The app's account can no longer delete applications (the app never does); deleting one would have
--      silently removed its interviews, submitted feedback and decision through the cascades.
--   5. Feedback independence applies only while feedback can still be written: once an interview ended as a
--      no-show or was cancelled, its interviewers may read colleagues' submitted feedback.
-- No existing data is changed.
BEGIN;

-- Is the candidate behind this application removed? Locks their record for share, so the check cannot
-- interleave with a removal in progress (the removal locks the same row for update). Internal only.
CREATE FUNCTION "interview_candidate_removed"(p_application UUID, p_org UUID) RETURNS BOOLEAN AS $$
DECLARE
  v_removed BOOLEAN;
BEGIN
  SELECT oc."removed_at" IS NOT NULL INTO v_removed
  FROM "applications" a JOIN "organization_candidates" oc ON oc."id" = a."organization_candidate_id"
  WHERE a."id" = p_application AND a."organization_id" = p_org
  FOR SHARE OF oc;
  RETURN COALESCE(v_removed, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2-3. Interviews
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_interview_changes"() RETURNS trigger AS $$
DECLARE
  v_stage TEXT;
  v_removed TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."created_by_id" IS DISTINCT FROM "app_user_id"() THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."status" <> 'SCHEDULED' OR NEW."cancel_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'interview_must_start_scheduled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scheduled_start" <= now() THEN
      RAISE EXCEPTION 'interview_in_past' USING ERRCODE = 'P0001';
    END IF;
    SELECT a."stage"::TEXT, oc."removed_at" INTO v_stage, v_removed
    FROM "applications" a JOIN "organization_candidates" oc ON oc."id" = a."organization_candidate_id"
    WHERE a."id" = NEW."application_id" AND a."organization_id" = NEW."organization_id"
    FOR SHARE OF oc;
    IF v_stage IS NULL OR v_removed IS NOT NULL
       OR v_stage NOT IN ('APPLIED', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED') THEN
      RAISE EXCEPTION 'application_not_open' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id" OR NEW."application_id" <> OLD."application_id"
     OR NEW."round_number" <> OLD."round_number" OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'interview_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'interview_closed' USING ERRCODE = 'P0001';
  END IF;
  IF "interview_candidate_removed"(OLD."application_id", OLD."organization_id") THEN
    RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" = 'SCHEDULED' THEN
    IF (NEW."scheduled_start", NEW."scheduled_end") IS DISTINCT FROM (OLD."scheduled_start", OLD."scheduled_end") THEN
      IF OLD."scheduled_start" <= now() THEN
        RAISE EXCEPTION 'interview_started' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."scheduled_start" <= now() THEN
        RAISE EXCEPTION 'interview_in_past' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF NEW."status" IN ('COMPLETED', 'NO_SHOW') THEN
    IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'interview_fixed_fields' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."scheduled_start" > now() THEN
      RAISE EXCEPTION 'interview_not_started' USING ERRCODE = 'P0001';
    END IF;
  ELSE -- CANCELLED
    IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'cancel_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at' - 'cancel_reason') THEN
      RAISE EXCEPTION 'interview_fixed_fields' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1, 3. Interviewers: fixed once the interview has started
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_interview_participants"() RETURNS trigger AS $$
DECLARE
  v_interview UUID;
  v_org UUID;
  v_status TEXT;
  v_start TIMESTAMPTZ;
  v_application UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interview := OLD."interview_id"; v_org := OLD."organization_id";
  ELSE
    v_interview := NEW."interview_id"; v_org := NEW."organization_id";
  END IF;
  -- Locks the interview, so two changes to its interviewers (or one racing a reschedule) run one after the other.
  SELECT i."status"::TEXT, i."scheduled_start", i."application_id" INTO v_status, v_start, v_application
  FROM "interviews" i WHERE i."id" = v_interview AND i."organization_id" = v_org
  FOR UPDATE;
  IF v_status IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'interview_closed' USING ERRCODE = 'P0001';
  END IF;
  IF v_start <= now() THEN
    RAISE EXCEPTION 'interview_started' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF "interview_candidate_removed"(v_application, v_org) THEN
      RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "organization_members" m
      JOIN "organization_member_roles" mr ON mr."member_id" = m."id"
      JOIN "roles" r ON r."id" = mr."role_id"
      JOIN "users" u ON u."id" = m."user_id"
      WHERE m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."interviewer_id"
        AND m."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND r."key" IN ('SUPER_ADMIN', 'HR_MANAGER')) THEN
      RAISE EXCEPTION 'interviewer_not_eligible' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE (before the start no feedback can exist; checked anyway).
  IF EXISTS (SELECT 1 FROM "interview_feedback" f WHERE f."participant_id" = OLD."id") THEN
    RAISE EXCEPTION 'participant_has_feedback' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Feedback and decisions: nothing new about a removed candidate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_interview_feedback"() RETURNS trigger AS $$
DECLARE
  v_application UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."submitted_at" IS NOT NULL THEN
      RAISE EXCEPTION 'feedback_submitted' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id" OR NEW."participant_id" <> OLD."participant_id"
       OR NEW."interviewer_id" <> OLD."interviewer_id" OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'feedback_fixed_fields' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."interviewer_id" IS DISTINCT FROM "app_user_id"() OR NOT EXISTS (
       SELECT 1 FROM "interview_participants" p
       WHERE p."id" = NEW."participant_id" AND p."organization_id" = NEW."organization_id" AND p."interviewer_id" = NEW."interviewer_id") THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i."application_id" INTO v_application
  FROM "interview_participants" p JOIN "interviews" i ON i."id" = p."interview_id"
  WHERE p."id" = NEW."participant_id" AND i."status" IN ('SCHEDULED', 'COMPLETED') AND i."scheduled_start" <= now();
  IF v_application IS NULL THEN
    RAISE EXCEPTION 'feedback_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF "interview_candidate_removed"(v_application, NEW."organization_id") THEN
    RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "guard_hiring_decisions"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id" OR NEW."application_id" <> OLD."application_id") THEN
    RAISE EXCEPTION 'decision_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decided_by_id" IS DISTINCT FROM "app_user_id"() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF "interview_candidate_removed"(NEW."application_id", NEW."organization_id") THEN
    RAISE EXCEPTION 'candidate_removed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "interviews" i
                 WHERE i."application_id" = NEW."application_id" AND i."organization_id" = NEW."organization_id" AND i."status" = 'COMPLETED') THEN
    RAISE EXCEPTION 'decision_needs_interview' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 5. Independence only while feedback can still be written
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app_feedback_visible"(p_participant UUID) RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "interview_participants" theirs
    JOIN "interviews" i ON i."id" = theirs."interview_id"
    JOIN "interview_participants" mine ON mine."interview_id" = theirs."interview_id"
    LEFT JOIN "interview_feedback" f ON f."participant_id" = mine."id"
    WHERE theirs."id" = p_participant AND mine."interviewer_id" = "app_user_id"()
      AND mine."organization_id" = "app_org_id"() AND f."submitted_at" IS NULL
      AND i."status" IN ('SCHEDULED', 'COMPLETED'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. The app never deletes applications
-- ---------------------------------------------------------------------------
REVOKE DELETE, TRUNCATE ON "applications" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 3. Removing a candidate: also cancel their scheduled interviews and clear place and link
-- ---------------------------------------------------------------------------
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
REVOKE ALL ON FUNCTION "interview_candidate_removed"(UUID, UUID) FROM PUBLIC;

COMMIT;
