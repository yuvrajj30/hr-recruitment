-- Interviews and feedback (milestone decided 17 Nov 2026).
--
-- The tables (interviews, interview_participants, interview_feedback, hiring_decisions) have existed since the
-- first migration but nothing used them. This migration adds the rules the database itself enforces before the
-- app starts writing to them:
--
--   1. Who: only Super Admins and HR Managers schedule, take part in, give feedback on and decide (there is no
--      Interviewer role; the published candidate privacy notice says only HR staff see applicants' details).
--      A participant must be an ACTIVE Super Admin or HR Manager of the same organisation, checked by the
--      database when they are added.
--   2. Interviews are never deleted (cancelled, with a reason, instead). Only a scheduled interview can change;
--      completed, no-show and cancelled ones are final. An interview is scheduled in the future, for an
--      application that is still open and whose candidate was not removed; "completed" and "no-show" only once
--      it has started. The person who scheduled it is the signed-in person (never a value from the browser).
--   3. Feedback is one independent evaluation per interviewer: written only by that interviewer, only once the
--      interview has started, private while it is a draft, and locked once submitted. Someone who interviewed
--      the candidate sees colleagues' submitted feedback only after submitting their own.
--   4. A hiring decision needs at least one completed interview and is recorded under the signed-in person.
--   5. Removing a candidate (app_remove_candidate) now also clears what was written about them in interviews,
--      feedback and decisions; ratings, recommendations, outcomes and dates stay, without personal data.
-- No existing data is changed (these tables are empty).
BEGIN;

-- ---------------------------------------------------------------------------
-- Value rules (extra rules that Prisma's schema language cannot express; added by hand)
-- ---------------------------------------------------------------------------
ALTER TABLE "interviews"
  ADD CONSTRAINT "interviews_times" CHECK ("scheduled_end" > "scheduled_start" AND "scheduled_end" <= "scheduled_start" + INTERVAL '12 hours'),
  ADD CONSTRAINT "interviews_round_number" CHECK ("round_number" BETWEEN 1 AND 50),
  ADD CONSTRAINT "interviews_round_name_length" CHECK ("round_name" IS NULL OR length(btrim("round_name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "interviews_meeting_link" CHECK ("meeting_link" IS NULL OR ("meeting_link" ~ '^https://[^\s]+$' AND length("meeting_link") <= 500)),
  ADD CONSTRAINT "interviews_location_length" CHECK ("location" IS NULL OR length(btrim("location")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "interviews_instructions_length" CHECK ("instructions" IS NULL OR length("instructions") <= 4000),
  ADD CONSTRAINT "interviews_where" CHECK (("type" <> 'ONLINE' OR "meeting_link" IS NOT NULL) AND ("type" <> 'IN_PERSON' OR "location" IS NOT NULL)),
  ADD CONSTRAINT "interviews_cancel_reason" CHECK (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL) AND ("cancel_reason" IS NULL OR length(btrim("cancel_reason")) BETWEEN 1 AND 1000));

ALTER TABLE "interview_feedback"
  ADD CONSTRAINT "interview_feedback_ratings" CHECK (
    ("technical_knowledge" IS NULL OR "technical_knowledge" BETWEEN 1 AND 5) AND ("communication" IS NULL OR "communication" BETWEEN 1 AND 5) AND
    ("problem_solving" IS NULL OR "problem_solving" BETWEEN 1 AND 5) AND ("confidence" IS NULL OR "confidence" BETWEEN 1 AND 5) AND
    ("relevant_experience" IS NULL OR "relevant_experience" BETWEEN 1 AND 5) AND ("role_suitability" IS NULL OR "role_suitability" BETWEEN 1 AND 5) AND
    ("overall_rating" IS NULL OR "overall_rating" BETWEEN 1 AND 5)),
  ADD CONSTRAINT "interview_feedback_text_length" CHECK (
    ("strengths" IS NULL OR length("strengths") <= 4000) AND ("weaknesses" IS NULL OR length("weaknesses") <= 4000) AND ("notes" IS NULL OR length("notes") <= 4000)),
  -- Submitted feedback always says what the interviewer concluded.
  ADD CONSTRAINT "interview_feedback_submitted_complete" CHECK ("submitted_at" IS NULL OR ("overall_rating" IS NOT NULL AND "recommendation" IS NOT NULL));

ALTER TABLE "hiring_decisions"
  ADD CONSTRAINT "hiring_decisions_rationale_length" CHECK ("rationale" IS NULL OR length(btrim("rationale")) BETWEEN 1 AND 2000);

-- ---------------------------------------------------------------------------
-- 2. Interviews: what may change, and who scheduled them
-- ---------------------------------------------------------------------------
CREATE FUNCTION "guard_interview_changes"() RETURNS trigger AS $$
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
    WHERE a."id" = NEW."application_id" AND a."organization_id" = NEW."organization_id";
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
  IF NEW."status" = 'SCHEDULED' THEN
    IF (NEW."scheduled_start", NEW."scheduled_end") IS DISTINCT FROM (OLD."scheduled_start", OLD."scheduled_end")
       AND NEW."scheduled_start" <= now() THEN
      RAISE EXCEPTION 'interview_in_past' USING ERRCODE = 'P0001';
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

CREATE TRIGGER "interviews_guard_changes" BEFORE INSERT OR UPDATE ON "interviews"
  FOR EACH ROW WHEN (current_user = 'hr_runtime') EXECUTE FUNCTION "guard_interview_changes"();

-- Never deleted by the app (cancelled instead); removing test data and cascades stay with the owner account.
REVOKE DELETE, TRUNCATE ON "interviews" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 1. Participants: only active Super Admins and HR Managers; fixed once someone has written feedback
-- ---------------------------------------------------------------------------
CREATE FUNCTION "guard_interview_participants"() RETURNS trigger AS $$
DECLARE
  v_interview UUID;
  v_org UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interview := OLD."interview_id"; v_org := OLD."organization_id";
  ELSE
    v_interview := NEW."interview_id"; v_org := NEW."organization_id";
  END IF;
  IF (SELECT i."status" FROM "interviews" i WHERE i."id" = v_interview AND i."organization_id" = v_org)
     IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'interview_closed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
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
  -- DELETE: someone who has started their feedback stays on the interview.
  IF EXISTS (SELECT 1 FROM "interview_feedback" f WHERE f."participant_id" = OLD."id") THEN
    RAISE EXCEPTION 'participant_has_feedback' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "interview_participants_guard" BEFORE INSERT OR DELETE ON "interview_participants"
  FOR EACH ROW WHEN (current_user = 'hr_runtime') EXECUTE FUNCTION "guard_interview_participants"();

-- A participant row is added or removed, never edited.
REVOKE UPDATE, TRUNCATE ON "interview_participants" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 3. Feedback: own, independent, locked once submitted
-- ---------------------------------------------------------------------------
-- May the caller see this participant's SUBMITTED feedback? Not while the caller is a participant of the
-- same interview who has not submitted their own. (Owner's rights: it must look at feedback rows the caller
-- cannot see, and it only ever answers yes or no.)
CREATE FUNCTION "app_feedback_visible"(p_participant UUID) RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "interview_participants" theirs
    JOIN "interview_participants" mine ON mine."interview_id" = theirs."interview_id"
    LEFT JOIN "interview_feedback" f ON f."participant_id" = mine."id"
    WHERE theirs."id" = p_participant AND mine."interviewer_id" = "app_user_id"()
      AND mine."organization_id" = "app_org_id"() AND f."submitted_at" IS NULL);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "guard_interview_feedback"() RETURNS trigger AS $$
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
  IF NOT EXISTS (
       SELECT 1 FROM "interview_participants" p JOIN "interviews" i ON i."id" = p."interview_id"
       WHERE p."id" = NEW."participant_id" AND i."status" IN ('SCHEDULED', 'COMPLETED') AND i."scheduled_start" <= now()) THEN
    RAISE EXCEPTION 'feedback_not_open' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "interview_feedback_guard" BEFORE INSERT OR UPDATE ON "interview_feedback"
  FOR EACH ROW WHEN (current_user = 'hr_runtime') EXECUTE FUNCTION "guard_interview_feedback"();

DROP POLICY "hr_same_org" ON "interview_feedback";
CREATE POLICY "hr_reads_feedback" ON "interview_feedback" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"())
         AND ("interviewer_id" = (SELECT "app_user_id"()) OR ("submitted_at" IS NOT NULL AND "app_feedback_visible"("participant_id"))));
CREATE POLICY "interviewer_writes_own" ON "interview_feedback" FOR INSERT
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()) AND "interviewer_id" = (SELECT "app_user_id"()));
CREATE POLICY "interviewer_edits_own_draft" ON "interview_feedback" FOR UPDATE
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()) AND "interviewer_id" = (SELECT "app_user_id"()) AND "submitted_at" IS NULL)
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()) AND "interviewer_id" = (SELECT "app_user_id"()));

-- Feedback is never deleted by the app.
REVOKE DELETE, TRUNCATE ON "interview_feedback" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 4. Hiring decisions
-- ---------------------------------------------------------------------------
CREATE FUNCTION "guard_hiring_decisions"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id" OR NEW."application_id" <> OLD."application_id") THEN
    RAISE EXCEPTION 'decision_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decided_by_id" IS DISTINCT FROM "app_user_id"() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "interviews" i
                 WHERE i."application_id" = NEW."application_id" AND i."organization_id" = NEW."organization_id" AND i."status" = 'COMPLETED') THEN
    RAISE EXCEPTION 'decision_needs_interview' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "hiring_decisions_guard" BEFORE INSERT OR UPDATE ON "hiring_decisions"
  FOR EACH ROW WHEN (current_user = 'hr_runtime') EXECUTE FUNCTION "guard_hiring_decisions"();

REVOKE DELETE, TRUNCATE ON "hiring_decisions" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 5. Removing a candidate also clears what was written about them in interviews, feedback and decisions
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
  UPDATE "interviews" SET "round_name" = NULL, "instructions" = NULL,
      "cancel_reason" = CASE WHEN "cancel_reason" IS NULL THEN NULL ELSE 'Removed with the candidate''s data' END, "updated_at" = p_now
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
REVOKE ALL ON FUNCTION "guard_interview_changes"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_interview_participants"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_interview_feedback"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_hiring_decisions"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_feedback_visible"(UUID) FROM PUBLIC;
-- Used inside a row-level-security policy, which runs as the app's account.
GRANT EXECUTE ON FUNCTION "app_feedback_visible"(UUID) TO hr_runtime;

COMMIT;
