-- Shared limits and automatic retention (SaaS readiness, 20 Nov 2026).
--
-- 1. Public application rate limits are counted in the database, so every app server shares one count (they
--    were counted in each server's memory). Only keyed hashes of the visitor's address and the email are stored,
--    never the address or the email, and every row is deleted again within an hour.
-- 2. Candidates who are due for removal under their organisation's retention period are removed automatically
--    by a job (app_remove_due_candidates). The DATABASE decides who is due, from each organisation's own setting
--    and its own clock, so the job cannot remove anyone else. The removal itself is the same code a person's
--    "Remove" uses: it moved, unchanged, into app_remove_candidate_core.
-- 3. A removed candidate's files: the database remembers which files still have to be deleted from storage
--    (file_removed_at is empty until the storage confirms), so a failed deletion is retried by the job.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Public application rate limits
-- ---------------------------------------------------------------------------
CREATE TABLE "public_apply_rate_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "bucket" TEXT NOT NULL CHECK ("bucket" IN ('address', 'unknown_address', 'email')),
  "key_hash" TEXT NOT NULL CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "public_apply_rate_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "public_apply_rate_events_bucket_key_hash_created_at_idx" ON "public_apply_rate_events"("bucket", "key_hash", "created_at");
CREATE INDEX "public_apply_rate_events_created_at_idx" ON "public_apply_rate_events"("created_at");
-- Nobody reads or writes it directly; only the function below (owner's rights).
ALTER TABLE "public_apply_rate_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public_apply_rate_events" FROM PUBLIC;
REVOKE ALL ON "public_apply_rate_events" FROM hr_runtime;

-- TRUE and counted when the submission is within the limits; FALSE (nothing counted) when it is not.
-- Limits (same as PUBLIC_APPLY_LIMITS in src/lib/recruitment/abuse.ts): 5 per 10 minutes per address, 30 per
-- 10 minutes for all visitors whose address is unknown together, 5 per hour per email. The database's own clock
-- is used, and the counting is serialised per key, so parallel submissions cannot slip past a limit.
CREATE FUNCTION "app_public_apply_allowed"(p_address_hash TEXT, p_email_hash TEXT) RETURNS BOOLEAN AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_bucket TEXT := CASE WHEN p_address_hash IS NULL THEN 'unknown_address' ELSE 'address' END;
  v_address TEXT := COALESCE(p_address_hash, repeat('0', 64));
  v_address_limit INT := CASE WHEN p_address_hash IS NULL THEN 30 ELSE 5 END;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'public_apply' OR p_email_hash IS NULL THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Always the address first, then the email: two submissions never wait on each other in opposite order.
  PERFORM pg_advisory_xact_lock(hashtextextended('apply:' || v_bucket || ':' || v_address, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('apply:email:' || p_email_hash, 0));
  DELETE FROM "public_apply_rate_events" WHERE "created_at" < v_now - INTERVAL '1 hour';
  IF (SELECT count(*) FROM "public_apply_rate_events" WHERE "bucket" = v_bucket AND "key_hash" = v_address AND "created_at" > v_now - INTERVAL '10 minutes') >= v_address_limit
     OR (SELECT count(*) FROM "public_apply_rate_events" WHERE "bucket" = 'email' AND "key_hash" = p_email_hash AND "created_at" > v_now - INTERVAL '1 hour') >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO "public_apply_rate_events" ("bucket", "key_hash", "created_at") VALUES (v_bucket, v_address, v_now), ('email', p_email_hash, v_now);
  RETURN true;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. Removal: one core, called by a person or by the retention job
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_remove_candidate_core"(p_org UUID, p_actor UUID, p_organization_candidate_id UUID, p_now TIMESTAMPTZ, p_reason TEXT)
RETURNS TABLE ("storage_keys" TEXT[], "applications_kept" INTEGER, "files" INTEGER, "profile" TEXT) AS $$
DECLARE
  v_org UUID := p_org;
  v_actor UUID := p_actor;
  v_oc RECORD;
  v_apps UUID[];
  v_keys TEXT[];
  v_target UUID;
  v_profile TEXT;
BEGIN
  -- Called only by app_remove_candidate (a signed-in person with candidate:delete) and app_remove_due_candidates
  -- (the retention job, no person). Not callable by the app account itself.
  IF v_org IS NULL OR p_now IS NULL OR p_reason IS NULL OR p_reason NOT IN ('staff', 'retention')
     OR (p_reason = 'staff' AND v_actor IS NULL) THEN
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
      jsonb_build_object('applicationsKept', cardinality(v_apps), 'filesDeleted', cardinality(v_keys), 'profile', v_profile, 'reason', p_reason),
      p_now);

  RETURN QUERY SELECT v_keys, cardinality(v_apps), cardinality(v_keys), v_profile;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "app_remove_candidate"(p_organization_candidate_id UUID, p_now TIMESTAMPTZ)
RETURNS TABLE ("storage_keys" TEXT[], "applications_kept" INTEGER, "files" INTEGER, "profile" TEXT) AS $$
BEGIN
  IF "app_org_id"() IS NULL OR "app_user_id"() IS NULL OR p_now IS NULL OR NOT EXISTS (
       SELECT 1 FROM "role_permissions" rp
       JOIN "roles" r ON r."id" = rp."role_id"
       JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE r."key" = "app_staff_role"() AND p."key" = 'candidate:delete') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT c."storage_keys", c."applications_kept", c."files", c."profile"
  FROM "app_remove_candidate_core"("app_org_id"(), "app_user_id"(), p_organization_candidate_id, p_now, 'staff') c;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The retention job (app mode 'maintenance', no person): removes up to p_limit candidates who are due NOW, by
-- the same rule as the "Due for removal" list (src/lib/recruitment/privacy.ts listDueForRemoval): every one of
-- their applications to that organisation finished without a hire (rejected, withdrawn, offer declined), the
-- last of them changed longer ago than the organisation's retention period. Oldest first. Returns what it removed
-- and which files the caller must now delete from storage. p_org NULL = every organisation (the daily job);
-- an organisation id limits it to that organisation.
CREATE FUNCTION "app_remove_due_candidates"(p_limit INTEGER, p_org UUID)
RETURNS TABLE ("organization_id" UUID, "organization_candidate_id" UUID, "storage_keys" TEXT[]) AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  r RECORD;
  k TEXT[];
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN
    SELECT oc."id", oc."organization_id", max(a."stage_changed_at") AS last_closed
    FROM "organization_candidates" oc
    JOIN "organizations" o ON o."id" = oc."organization_id"
    JOIN "applications" a ON a."organization_candidate_id" = oc."id" AND a."organization_id" = oc."organization_id"
    WHERE oc."removed_at" IS NULL AND (p_org IS NULL OR oc."organization_id" = p_org)
    GROUP BY oc."id", oc."organization_id", o."candidate_retention_months"
    HAVING bool_and(a."stage" IN ('REJECTED', 'WITHDRAWN', 'OFFER_DECLINED'))
       AND max(a."stage_changed_at") < v_now - make_interval(months => o."candidate_retention_months")
    ORDER BY max(a."stage_changed_at"), oc."id"
    LIMIT p_limit
  LOOP
    SELECT c."storage_keys" INTO k FROM "app_remove_candidate_core"(r."organization_id", NULL, r."id", v_now, 'retention') c;
    "organization_id" := r."organization_id";
    "organization_candidate_id" := r."id";
    "storage_keys" := k;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Files still to be deleted from storage
-- ---------------------------------------------------------------------------
ALTER TABLE "candidate_documents" ADD COLUMN "file_removed_at" TIMESTAMPTZ(6);
CREATE INDEX "candidate_documents_pending_file_removal_idx" ON "candidate_documents"("deleted_at") WHERE "deleted_at" IS NOT NULL AND "file_removed_at" IS NULL;

-- The job asks which files of removed documents are still to be deleted (storage keys are random names, not
-- personal data) and confirms each one once storage has deleted it.
CREATE FUNCTION "app_pending_file_removals"(p_limit INTEGER, p_org UUID) RETURNS TABLE ("id" UUID, "storage_key" TEXT) AS $$
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT d."id", d."storage_key" FROM "candidate_documents" d
  WHERE d."deleted_at" IS NOT NULL AND d."file_removed_at" IS NULL AND (p_org IS NULL OR d."organization_id" = p_org) ORDER BY d."deleted_at", d."id" LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "app_confirm_file_removed"(p_ids UUID[]) RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_ids IS NULL THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE "candidate_documents" SET "file_removed_at" = clock_timestamp()
  WHERE "id" = ANY(p_ids) AND "deleted_at" IS NOT NULL AND "file_removed_at" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- Execution rights
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "app_public_apply_allowed"(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_remove_candidate_core"(UUID, UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_pending_file_removals"(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_confirm_file_removed"(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_public_apply_allowed"(TEXT, TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_remove_due_candidates"(INTEGER, UUID) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_pending_file_removals"(INTEGER, UUID) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_confirm_file_removed"(UUID[]) TO hr_runtime;
-- NOT granted: app_remove_candidate_core (only the two removal functions above call it).

COMMIT;
