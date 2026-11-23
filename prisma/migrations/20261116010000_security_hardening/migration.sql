-- Security hardening (independent review of the three-role, row-level-security, user-management, invitation and
-- timestamp-correction migrations, 2026-11-15). No application data is changed.
--
-- What the review proved on the test database, and what this migration does about it:
--   1. The app's restricted account (hr_runtime) could claim to be any user: the "who is asking" settings were
--      plain values it set itself.  -> Identity now comes from a LIVE SESSION TOKEN that the database checks
--      itself (only the token's fingerprint is stored, so a token cannot be made up).
--   2. It could create sessions and overwrite password hashes directly.  -> Sessions are created, and passwords
--      checked and stored, only by narrow database functions; the account can no longer read password hashes.
--   3. A temporary table could stand in for a real table inside the "owner's rights" helper functions and make
--      a non-existent user a Super Admin.  -> Every such function searches temporary tables LAST, and the
--      restricted account can no longer create temporary tables.
--   4. With nothing set (the sign-in path) it could change any organisation's memberships and roles.
--      -> That path is now read-only.
--   5. The public careers form's database context could read and change existing candidate data.
--      -> A public application is saved by ONE function; public mode has no access to candidate tables at all.
--   6. Helper functions answered questions about members of other organisations, and were open to every
--      database role.  -> They answer only about the caller's own organisation; execution is granted explicitly.
--   7. Smaller items: notification recipients may change only "read at"; invitations stop working when their
--      sender loses the right to invite; audit records can only be added for one's own context; the timestamp
--      correction notes follow the audit log's own access rules; roles and permissions are read-only to the app.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Foundations
-- ---------------------------------------------------------------------------
-- Password checking inside the database (bcrypt). A trusted extension: the database owner may install it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Only the owner account (migrations use temporary tables) may create temporary tables.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO hr_app', current_database());
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who is asking: taken from a live session, never from a value the app states
-- ---------------------------------------------------------------------------
-- The app passes the RAW session token (from the cookie) as app.session_token. Only its SHA-256 fingerprint is
-- stored, so the token must be a real, live one: not revoked, not past its idle or hard deadline.
CREATE FUNCTION "app_session_identity"() RETURNS TABLE ("user_id" UUID, "org_id" UUID, "session_id" UUID) AS $$
  SELECT s."user_id", s."active_organization_id", s."id"
  FROM "sessions" s
  WHERE current_setting('app.mode', true) = 'staff'
    AND NULLIF(current_setting('app.session_token', true), '') IS NOT NULL
    AND s."token_hash" = encode(sha256(convert_to(current_setting('app.session_token', true), 'UTF8')), 'hex')
    AND s."revoked_at" IS NULL AND s."expires_at" > now() AND s."absolute_expires_at" > now();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- app.user_id is no longer read at all. app.org_id is read only for the anonymous public careers form.
CREATE OR REPLACE FUNCTION "app_user_id"() RETURNS UUID AS $$
  SELECT i."user_id" FROM "app_session_identity"() i;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "app_org_id"() RETURNS UUID AS $$
  SELECT CASE "app_mode"()
    WHEN 'staff' THEN (SELECT i."org_id" FROM "app_session_identity"() i)
    WHEN 'public_apply' THEN "app_setting"('org_id')::UUID
  END;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 2. Member helpers: only about the caller's own organisation (review issue 2)
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_member_in_my_org"(member UUID) RETURNS BOOLEAN AS $$
  SELECT "app_staff_role"() IS NOT NULL AND EXISTS (
    SELECT 1 FROM "organization_members" om WHERE om."id" = member AND om."organization_id" = "app_org_id"());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "app_member_is_me"(member UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "organization_members" om
    WHERE om."id" = member AND om."user_id" = "app_user_id"() AND om."organization_id" = "app_org_id"());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The role of a member of MY organisation, and only for its Super Admins and HR Managers. Anyone else: nothing.
CREATE OR REPLACE FUNCTION "app_member_role_key"(member UUID) RETURNS TEXT AS $$
  SELECT r."key"
  FROM "organization_member_roles" omr
  JOIN "roles" r ON r."id" = omr."role_id"
  JOIN "organization_members" om ON om."id" = omr."member_id"
  WHERE omr."member_id" = member AND om."organization_id" = "app_org_id"() AND "app_is_hr"()
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

DROP POLICY "super_admin_changes_roles" ON "organization_member_roles";
CREATE POLICY "super_admin_changes_roles" ON "organization_member_roles" FOR UPDATE
  USING ((SELECT "app_is_super_admin"()) AND "app_member_in_my_org"("member_id") AND NOT "app_member_is_me"("member_id"))
  WITH CHECK ((SELECT "app_is_super_admin"()) AND "app_member_in_my_org"("member_id") AND NOT "app_member_is_me"("member_id"));
DROP FUNCTION "app_member_org"(UUID);
DROP FUNCTION "app_member_user"(UUID);

-- ---------------------------------------------------------------------------
-- 3. The sign-in path (nothing set) is read-only (review issue 3)
-- ---------------------------------------------------------------------------
DROP POLICY "identity_lookup" ON "organization_members";
DROP POLICY "identity_lookup" ON "organization_member_roles";
DROP POLICY "identity_lookup" ON "organizations";
CREATE POLICY "identity_lookup" ON "organization_members" FOR SELECT USING ("app_mode"() IS NULL);
CREATE POLICY "identity_lookup" ON "organization_member_roles" FOR SELECT USING ("app_mode"() IS NULL);
CREATE POLICY "identity_lookup" ON "organizations" FOR SELECT USING ("app_mode"() IS NULL);

-- ---------------------------------------------------------------------------
-- 4. Notifications: a recipient may only mark their own notification as read (review issue 3)
-- ---------------------------------------------------------------------------
DROP POLICY "own_notifications_update" ON "notifications";
CREATE POLICY "own_notifications_update" ON "notifications" FOR UPDATE
  USING ("app_mode"() = 'staff' AND "organization_id" = "app_org_id"() AND "recipient_user_id" = "app_user_id"() AND (SELECT "app_staff_role"()) IS NOT NULL)
  WITH CHECK ("app_mode"() = 'staff' AND "organization_id" = "app_org_id"() AND "recipient_user_id" = "app_user_id"() AND (SELECT "app_staff_role"()) IS NOT NULL);

CREATE FUNCTION "notifications_recipient_marks_read_only"() RETURNS trigger AS $$
BEGIN
  IF NOT "app_is_hr"() AND (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'only read_at may be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "notifications_recipient_marks_read_only"
  BEFORE UPDATE ON "notifications"
  FOR EACH ROW WHEN (current_user = 'hr_runtime')
  EXECUTE FUNCTION "notifications_recipient_marks_read_only"();

-- ---------------------------------------------------------------------------
-- 5. The public careers form (review issue 3)
-- ---------------------------------------------------------------------------
-- Public mode loses every right on candidate and application data ...
DROP POLICY "public_read" ON "organization_candidates";
DROP POLICY "public_insert" ON "organization_candidates";
DROP POLICY "public_upsert" ON "organization_candidates";
DROP POLICY "public_read" ON "applications";
DROP POLICY "public_insert" ON "applications";
DROP POLICY "public_read" ON "application_status_history";
DROP POLICY "public_insert" ON "application_status_history";
DROP POLICY "public_read" ON "candidate_documents";
DROP POLICY "public_insert" ON "candidate_documents";
-- ... and can no longer list organisations (their owner and settings were visible).
DROP POLICY "public_active" ON "organizations";

-- What the careers pages need to know about an organisation, by its public web address. ACTIVE ones only.
CREATE FUNCTION "app_public_organization"(p_slug TEXT)
RETURNS TABLE ("id" UUID, "name" TEXT, "slug" TEXT, "timezone" TEXT) AS $$
  SELECT o."id", o."name", o."slug", o."timezone"
  FROM "organizations" o
  WHERE o."slug" = p_slug AND o."status" = 'ACTIVE' AND "app_mode"() = 'public_apply';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The candidate-profile function was callable by public mode on its own. Its work moves to an internal
-- function that the app cannot call; the public form reaches it only through app_submit_public_application,
-- and the original name stays as a wrapper for HR staff (manual entry of an application).
CREATE FUNCTION "app_candidate_profile_internal"(
  p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT, p_linkedin_url TEXT, p_portfolio_url TEXT,
  p_education JSONB, p_experience JSONB, p_skills TEXT[]
) RETURNS TABLE ("id" UUID, "created" BOOLEAN) AS $$
DECLARE
  v_id UUID;
  v_created BOOLEAN := false;
BEGIN
  IF p_email IS NULL OR p_email <> lower(btrim(p_email)) OR p_email = '' THEN
    RAISE EXCEPTION 'email must be normalised' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "candidate_profiles" ("id", "email", "full_name", "phone", "city", "linkedin_url", "portfolio_url", "updated_at")
  VALUES (gen_random_uuid(), p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url, CURRENT_TIMESTAMP)
  ON CONFLICT ("email") DO NOTHING
  RETURNING "candidate_profiles"."id" INTO v_id;

  IF v_id IS NOT NULL THEN
    v_created := true;
    IF p_education IS NOT NULL THEN
      INSERT INTO "candidate_educations" ("id", "candidate_id", "institution", "course", "degree", "graduation_year")
      VALUES (gen_random_uuid(), v_id, p_education->>'institution', p_education->>'course', p_education->>'degree', (p_education->>'graduationYear')::INT);
    END IF;
    IF p_experience IS NOT NULL THEN
      INSERT INTO "candidate_experiences" ("id", "candidate_id", "company", "title", "description")
      VALUES (gen_random_uuid(), v_id, p_experience->>'company', p_experience->>'title', p_experience->>'description');
    END IF;
    INSERT INTO "candidate_skills" ("id", "candidate_id", "name")
    SELECT gen_random_uuid(), v_id, s FROM (SELECT DISTINCT lower(x) AS s FROM unnest(COALESCE(p_skills, ARRAY[]::TEXT[])) AS x) skills
    WHERE s <> '';
  ELSE
    SELECT cp."id" INTO v_id FROM "candidate_profiles" cp WHERE cp."email" = p_email;
  END IF;

  RETURN QUERY SELECT v_id, v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "app_find_or_create_candidate_profile"(
  p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT, p_linkedin_url TEXT, p_portfolio_url TEXT,
  p_education JSONB, p_experience JSONB, p_skills TEXT[]
) RETURNS TABLE ("id" UUID, "created" BOOLEAN) AS $$
BEGIN
  IF NOT "app_is_hr"() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT f."id", f."created"
  FROM "app_candidate_profile_internal"(p_email, p_full_name, p_phone, p_city, p_linkedin_url, p_portfolio_url, p_education, p_experience, p_skills) f;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ONE public application, start to finish. The caller learns only the new application's id and reference, and
-- whether the email was already known; a duplicate is refused without revealing the existing application.
CREATE FUNCTION "app_submit_public_application"(
  p_job_id UUID, p_reference TEXT, p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT,
  p_linkedin_url TEXT, p_portfolio_url TEXT, p_education JSONB, p_experience JSONB, p_skills TEXT[],
  p_source TEXT, p_snapshot JSONB, p_privacy_notice_version TEXT, p_now TIMESTAMPTZ,
  p_resume_name TEXT, p_resume_key TEXT, p_resume_mime TEXT, p_resume_size INT, p_resume_sha256 TEXT,
  p_ip TEXT, p_user_agent TEXT
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
      "applied_at", "created_at", "updated_at")
  VALUES (gen_random_uuid(), v_org, p_reference, v_oc, p_job_id, 'APPLIED',
      p_now, p_source, p_snapshot, NULL, p_now, p_privacy_notice_version, p_now, p_now, p_now)
  RETURNING "id" INTO v_app;

  INSERT INTO "application_status_history" ("id", "organization_id", "application_id", "from_stage", "to_stage", "changed_by_id", "created_at")
  VALUES (gen_random_uuid(), v_org, v_app, NULL, 'APPLIED', NULL, p_now);

  IF p_resume_key IS NOT NULL THEN
    INSERT INTO "candidate_documents" ("id", "candidate_id", "organization_id", "application_id", "kind", "original_name",
        "storage_key", "mime_type", "size_bytes", "sha256", "uploaded_at")
    VALUES (gen_random_uuid(), v_profile, v_org, v_app, 'RESUME', p_resume_name, p_resume_key, p_resume_mime, p_resume_size, p_resume_sha256, p_now);
  END IF;

  INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "metadata", "ip_address", "user_agent", "created_at")
  VALUES (gen_random_uuid(), v_org, NULL, 'application.submitted', 'application', v_app::TEXT,
      jsonb_build_object('reference', p_reference, 'jobId', p_job_id, 'knownCandidate', NOT v_created, 'hasResume', p_resume_key IS NOT NULL),
      left(p_ip, 64), left(p_user_agent, 512), p_now);

  RETURN QUERY SELECT v_app, p_reference, NOT v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 6. Audit log: records can only be added for one's own context
-- ---------------------------------------------------------------------------
DROP POLICY "anyone_appends" ON "audit_logs";
-- A signed-in member: their own organisation (or none), and themselves as the actor.
CREATE POLICY "staff_appends" ON "audit_logs" FOR INSERT
  WITH CHECK ("app_mode"() = 'staff' AND "actor_user_id" = "app_user_id"()
              AND ("organization_id" IS NULL OR "organization_id" = "app_org_id"()));
-- Sign-in, sign-out and switching organisation happen before a context exists: only "auth." records.
CREATE POLICY "sign_in_appends" ON "audit_logs" FOR INSERT
  WITH CHECK ("app_mode"() IS NULL AND "action" LIKE 'auth.%');
-- (A public application and an accepted invitation are recorded inside their own functions.)

-- ---------------------------------------------------------------------------
-- 7. Passwords and sessions: only through the database (review issue 3, part 2)
-- ---------------------------------------------------------------------------
-- bcryptjs writes "$2b$" hashes; pgcrypto reads "$2a$". The two are the same algorithm for these hashes.
-- ALWAYS does one full bcrypt check, also for a missing hash, so every failure takes about the same time.
CREATE FUNCTION "app_password_matches"(p_password TEXT, p_hash TEXT) RETURNS BOOLEAN AS $$
DECLARE
  -- A missing or malformed stored hash is replaced by a throw-away one (and can then never match).
  v_usable BOOLEAN := p_hash IS NOT NULL AND p_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$';
  v_hash TEXT := overlay(CASE WHEN v_usable THEN p_hash ELSE '$2a$12$floruH3d1VC93UYHdNzhz.ldTxopOL0Ex/1QwuoMSpg/X0Y97DTju' END PLACING '$2a$' FROM 1 FOR 4);
  v_same BOOLEAN;
BEGIN
  v_same := crypt(COALESCE(p_password, ''), v_hash) = v_hash;
  RETURN v_same AND v_usable AND p_password IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Sign in: checks the password and, only if it is right, creates the session. Every refusal looks the same.
-- (Throttling of repeated attempts and the audit record stay in the application, as before.)
CREATE FUNCTION "app_sign_in"(
  p_email TEXT, p_password TEXT, p_token_hash TEXT, p_expires_at TIMESTAMPTZ, p_absolute_expires_at TIMESTAMPTZ,
  p_now TIMESTAMPTZ, p_ip TEXT, p_user_agent TEXT
) RETURNS TABLE ("session_id" UUID, "user_id" UUID, "email" TEXT, "name" TEXT,
                 "organization_id" UUID, "organization_name" TEXT, "organization_slug" TEXT) AS $$
DECLARE
  v_user RECORD;
  v_org RECORD;
  v_ok BOOLEAN;
  v_session UUID;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at IS NULL OR p_absolute_expires_at IS NULL
     OR p_expires_at > p_absolute_expires_at OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'P0001';
  END IF;
  SELECT u."id", u."email", u."name", u."password_hash", u."status" INTO v_user FROM "users" u WHERE u."email" = lower(btrim(p_email));
  v_ok := "app_password_matches"(p_password, CASE WHEN v_user."status" = 'ACTIVE' THEN v_user."password_hash" END);
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'invalid_credentials' USING ERRCODE = 'P0001';
  END IF;
  -- The oldest ACTIVE membership of an ACTIVE organisation becomes the session's organisation.
  SELECT o."id", o."name", o."slug" INTO v_org
  FROM "organization_members" om JOIN "organizations" o ON o."id" = om."organization_id"
  WHERE om."user_id" = v_user."id" AND om."status" = 'ACTIVE' AND o."status" = 'ACTIVE'
  ORDER BY om."created_at", om."id" LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_credentials' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "sessions" ("id", "user_id", "active_organization_id", "token_hash", "expires_at", "absolute_expires_at",
                          "last_seen_at", "created_at", "ip_address", "user_agent")
  VALUES (gen_random_uuid(), v_user."id", v_org."id", p_token_hash, p_expires_at, p_absolute_expires_at, p_now, p_now, left(p_ip, 64), left(p_user_agent, 512))
  RETURNING "id" INTO v_session;
  UPDATE "users" u SET "last_login_at" = p_now WHERE u."id" = v_user."id";

  RETURN QUERY SELECT v_session, v_user."id", v_user."email", v_user."name", v_org."id", v_org."name", v_org."slug";
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- "Is this my current password?" for the signed-in person (identity from their session).
CREATE FUNCTION "app_my_password_matches"(p_password TEXT) RETURNS BOOLEAN AS $$
  SELECT "app_password_matches"(p_password, (SELECT u."password_hash" FROM "users" u WHERE u."id" = "app_user_id"() AND u."status" = 'ACTIVE'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Changes the signed-in person's OWN password and ends their other sessions. Returns how many were ended.
-- (The application checks the strength rules first; the database stores only the bcrypt hash.)
CREATE FUNCTION "app_change_my_password"(p_current TEXT, p_new TEXT, p_now TIMESTAMPTZ) RETURNS INT AS $$
DECLARE
  v_me RECORD;
  v_hash TEXT;
  v_ended INT;
BEGIN
  SELECT i."user_id", i."session_id" INTO v_me FROM "app_session_identity"() i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u."password_hash" INTO v_hash FROM "users" u WHERE u."id" = v_me."user_id" AND u."status" = 'ACTIVE' FOR UPDATE;
  IF NOT "app_password_matches"(p_current, v_hash) THEN
    RAISE EXCEPTION 'wrong_password' USING ERRCODE = 'P0001';
  END IF;
  IF p_new IS NULL OR length(p_new) < 8 OR length(p_new) > 200 THEN
    RAISE EXCEPTION 'password_required' USING ERRCODE = 'P0001';
  END IF;
  IF "app_password_matches"(p_new, v_hash) THEN
    RAISE EXCEPTION 'same_password' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "users" u SET "password_hash" = crypt(p_new, gen_salt('bf', 12)), "updated_at" = p_now WHERE u."id" = v_me."user_id";
  UPDATE "sessions" s SET "revoked_at" = p_now, "revoked_reason" = 'password_changed'
  WHERE s."user_id" = v_me."user_id" AND s."revoked_at" IS NULL AND s."id" <> v_me."session_id";
  GET DIAGNOSTICS v_ended = ROW_COUNT;
  RETURN v_ended;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- What the restricted account may still do with sessions directly: keep one alive, switch its organisation,
-- end it, and delete ended ones. It can never create one, move one to another user, or revive an ended one.
CREATE FUNCTION "guard_session_changes"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."revoked_at" IS NULL AND OLD."expires_at" > now() THEN
      RAISE EXCEPTION 'only ended sessions may be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'an ended session cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."expires_at" > NEW."absolute_expires_at" THEN
    RAISE EXCEPTION 'a session cannot outlive its hard deadline' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."active_organization_id" IS DISTINCT FROM OLD."active_organization_id" AND NEW."active_organization_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "organization_members" om JOIN "organizations" o ON o."id" = om."organization_id"
       WHERE om."user_id" = NEW."user_id" AND om."organization_id" = NEW."active_organization_id"
         AND om."status" = 'ACTIVE' AND o."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'not an active member of that organisation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "sessions_guard_changes"
  BEFORE UPDATE OR DELETE ON "sessions"
  FOR EACH ROW WHEN (current_user = 'hr_runtime')
  EXECUTE FUNCTION "guard_session_changes"();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "sessions" FROM hr_runtime;
GRANT UPDATE ("last_seen_at", "expires_at", "active_organization_id", "revoked_at", "revoked_reason") ON "sessions" TO hr_runtime;
GRANT DELETE ON "sessions" TO hr_runtime;

-- Users: the restricted account reads everything EXCEPT the password hash, and may change only the name of
-- the person whose session is asking.
CREATE FUNCTION "guard_user_changes"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM "app_user_id"() THEN
    RAISE EXCEPTION 'only your own account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER "users_guard_changes"
  BEFORE UPDATE ON "users"
  FOR EACH ROW WHEN (current_user = 'hr_runtime')
  EXECUTE FUNCTION "guard_user_changes"();

REVOKE ALL ON "users" FROM hr_runtime;
GRANT SELECT ("id", "email", "name", "is_platform_admin", "status", "last_login_at", "created_at", "updated_at") ON "users" TO hr_runtime;
GRANT UPDATE ("name", "updated_at") ON "users" TO hr_runtime;

-- ---------------------------------------------------------------------------
-- 8. Invitations (review issue 4)
-- ---------------------------------------------------------------------------
-- An invitation is only good while the person who sent it may still send that kind of invitation.
CREATE FUNCTION "app_invitation_sender_ok"(p_org UUID, p_sender UUID, p_role_key TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
    JOIN "roles" r ON r."id" = omr."role_id"
    JOIN "users" u ON u."id" = om."user_id"
    JOIN "organizations" o ON o."id" = om."organization_id"
    WHERE om."organization_id" = p_org AND om."user_id" = p_sender
      AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND o."status" = 'ACTIVE'
      AND (r."key" = 'SUPER_ADMIN' OR (r."key" = 'HR_MANAGER' AND p_role_key = 'EMPLOYEE' AND o."hr_can_invite_employees")));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "app_invitation_lookup"(p_token_hash TEXT)
RETURNS TABLE (
  "invitation_id" UUID, "organization_id" UUID, "organization_name" TEXT, "email" TEXT, "name" TEXT, "role_key" TEXT,
  "expires_at" TIMESTAMPTZ, "account_exists" BOOLEAN
) AS $$
  SELECT i."id", o."id", o."name", i."email", i."name", i."role_key", i."expires_at",
         EXISTS (SELECT 1 FROM "users" u WHERE u."email" = i."email")
  FROM "staff_invitations" i
  JOIN "organizations" o ON o."id" = i."organization_id"
  WHERE i."token_hash" = p_token_hash
    AND i."accepted_at" IS NULL AND i."revoked_at" IS NULL AND i."expires_at" > now()
    AND o."status" = 'ACTIVE'
    AND "app_invitation_sender_ok"(i."organization_id", i."invited_by_id", i."role_key");
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Replaces the earlier version: the password is now checked (existing account) or hashed (new account) HERE,
-- the role must exist, the sender must still be allowed, and the person's session is created in the same step.
DROP FUNCTION "app_accept_invitation"(TEXT, TEXT, TEXT);
CREATE FUNCTION "app_accept_invitation"(
  p_token_hash TEXT, p_name TEXT, p_password TEXT,
  p_session_token_hash TEXT, p_expires_at TIMESTAMPTZ, p_absolute_expires_at TIMESTAMPTZ, p_now TIMESTAMPTZ,
  p_ip TEXT, p_user_agent TEXT
) RETURNS TABLE ("user_id" UUID, "organization_id" UUID, "member_id" UUID, "role_key" TEXT, "new_account" BOOLEAN, "session_id" UUID) AS $$
DECLARE
  inv RECORD;
  v_user RECORD;
  v_user_id UUID;
  v_member_id UUID;
  v_session UUID;
  v_new BOOLEAN := false;
BEGIN
  IF p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at IS NULL OR p_absolute_expires_at IS NULL
     OR p_expires_at > p_absolute_expires_at OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'P0001';
  END IF;
  -- Lock the invitation row: a second, simultaneous acceptance waits here and then finds it used.
  SELECT i.* INTO inv FROM "staff_invitations" i
  JOIN "organizations" o ON o."id" = i."organization_id"
  WHERE i."token_hash" = p_token_hash AND o."status" = 'ACTIVE'
  FOR UPDATE OF i;
  IF NOT FOUND OR inv."accepted_at" IS NOT NULL OR inv."revoked_at" IS NOT NULL OR inv."expires_at" <= now()
     OR NOT "app_invitation_sender_ok"(inv."organization_id", inv."invited_by_id", inv."role_key") THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT u."id", u."status", u."password_hash" INTO v_user FROM "users" u WHERE u."email" = inv."email";
  IF FOUND THEN
    -- An existing account: prove ownership with ITS password. It is never changed here.
    IF NOT "app_password_matches"(p_password, v_user."password_hash") THEN
      RAISE EXCEPTION 'wrong_password' USING ERRCODE = 'P0001';
    END IF;
    IF v_user."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'account_disabled' USING ERRCODE = 'P0001';
    END IF;
    v_user_id := v_user."id";
  ELSE
    IF p_password IS NULL OR length(p_password) < 8 OR length(p_password) > 200 THEN
      RAISE EXCEPTION 'password_required' USING ERRCODE = 'P0001';
    END IF;
    IF p_name IS NULL OR length(btrim(p_name)) < 2 OR length(p_name) > 120 THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO "users" ("id", "email", "name", "password_hash", "status", "updated_at")
    VALUES (gen_random_uuid(), inv."email", btrim(p_name), crypt(p_password, gen_salt('bf', 12)), 'ACTIVE', p_now)
    RETURNING "users"."id" INTO v_user_id;
    v_new := true;
  END IF;

  IF EXISTS (SELECT 1 FROM "organization_members" om WHERE om."organization_id" = inv."organization_id" AND om."user_id" = v_user_id) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "organization_members" ("id", "organization_id", "user_id", "status", "invited_by_id", "joined_at", "updated_at")
  VALUES (gen_random_uuid(), inv."organization_id", v_user_id, 'ACTIVE', inv."invited_by_id", p_now, p_now)
  RETURNING "organization_members"."id" INTO v_member_id;

  INSERT INTO "organization_member_roles" ("member_id", "role_id")
  SELECT v_member_id, r."id" FROM "roles" r WHERE r."key" = inv."role_key";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role_missing' USING ERRCODE = 'P0001';
  END IF;

  UPDATE "staff_invitations" SET "accepted_at" = p_now, "accepted_user_id" = v_user_id WHERE "id" = inv."id";

  INSERT INTO "sessions" ("id", "user_id", "active_organization_id", "token_hash", "expires_at", "absolute_expires_at",
                          "last_seen_at", "created_at", "ip_address", "user_agent")
  VALUES (gen_random_uuid(), v_user_id, inv."organization_id", p_session_token_hash, p_expires_at, p_absolute_expires_at, p_now, p_now, left(p_ip, 64), left(p_user_agent, 512))
  RETURNING "id" INTO v_session;
  UPDATE "users" u SET "last_login_at" = p_now WHERE u."id" = v_user_id;

  INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "action", "entity_type", "entity_id", "metadata", "ip_address", "user_agent", "created_at")
  VALUES (gen_random_uuid(), inv."organization_id", v_user_id, 'invitation.accepted', 'staff_invitation', inv."id"::TEXT,
          jsonb_build_object('role', inv."role_key", 'newAccount', v_new, 'memberId', v_member_id), left(p_ip, 64), left(p_user_agent, 512), p_now);

  RETURN QUERY SELECT v_user_id, inv."organization_id", v_member_id, inv."role_key", v_new, v_session;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 9. Timestamp correction records (review issue 5)
-- ---------------------------------------------------------------------------
-- A correction note is visible only to someone who may see the audit row it belongs to (the audit log's own
-- row-level security decides). Nobody but the owner account can add notes or read the run record.
REVOKE ALL ON "timestamp_corrections", "audit_log_time_corrections", "audit_logs_display" FROM hr_runtime;
GRANT SELECT ON "audit_log_time_corrections", "audit_logs_display" TO hr_runtime;
ALTER TABLE "audit_log_time_corrections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "follows_audit_log" ON "audit_log_time_corrections" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "audit_logs" a WHERE a."id" = "audit_log_id"));

-- ---------------------------------------------------------------------------
-- 10. Least privilege on tables the app only reads or only updates
-- ---------------------------------------------------------------------------
-- Roles and permissions are fixed by migrations; the app only reads them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "roles", "permissions", "role_permissions" FROM hr_runtime;
-- Organisations and memberships are created by the seed, by migrations and by accepting an invitation
-- (owner's rights); the app itself only reads and updates them, under the policies above.
REVOKE INSERT, DELETE, TRUNCATE ON "organizations", "organization_members", "organization_member_roles" FROM hr_runtime;

-- ---------------------------------------------------------------------------
-- 11. Every "owner's rights" function: temporary tables searched last; explicit execution rights
-- ---------------------------------------------------------------------------
DO $$
DECLARE f REGPROCEDURE;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prosecdef
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')  -- not pgcrypto's own
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM hr_runtime', f);
  END LOOP;
END;
$$;

-- Called by row-level security policies and trigger conditions (which run as the asking account):
GRANT EXECUTE ON FUNCTION "app_session_identity"(), "app_staff_role"(), "app_member_in_my_org"(UUID), "app_member_is_me"(UUID),
                          "app_member_role_key"(UUID), "member_is_super_admin"(UUID), "role_is_super_admin"(UUID) TO hr_runtime;
-- Called by the application:
GRANT EXECUTE ON FUNCTION "app_public_organization"(TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_find_or_create_candidate_profile"(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[]) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_submit_public_application"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[], TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_sign_in"(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_my_password_matches"(TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_change_my_password"(TEXT, TEXT, TIMESTAMPTZ) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_invitation_lookup"(TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_accept_invitation"(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO hr_runtime;
-- NOT granted (used only inside other owner's-rights code): app_candidate_profile_internal, app_password_matches, app_invitation_sender_ok,
-- org_active_super_admins, and the guard_* / check_* trigger functions.

-- (pgcrypto's own functions, crypt and gen_salt, stay callable by everyone: they belong to the database
-- superuser, and they are pure calculations. Without the stored hashes, which the app account can no longer
-- read, they give nothing away.)

-- Functions created from now on are not open to everyone by default.
ALTER DEFAULT PRIVILEGES FOR ROLE hr_app IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 12. Policies look the identity up once per query, not once per row
-- ---------------------------------------------------------------------------
-- app_org_id() / app_user_id() now read the session; "(SELECT app_org_id())" is evaluated once per statement.
DO $$
DECLARE
  p RECORD;
  q TEXT;
  c TEXT;
BEGIN
  FOR p IN SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' LOOP
    q := regexp_replace(p.qual, '(?<![A-Za-z_])app_(org|user)_id\(\)', '(SELECT app_\1_id())', 'g');
    c := regexp_replace(p.with_check, '(?<![A-Za-z_])app_(org|user)_id\(\)', '(SELECT app_\1_id())', 'g');
    IF q IS DISTINCT FROM p.qual OR c IS DISTINCT FROM p.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I %s %s', p.policyname, p.tablename,
                     CASE WHEN q IS NOT NULL THEN 'USING (' || q || ')' ELSE '' END,
                     CASE WHEN c IS NOT NULL THEN 'WITH CHECK (' || c || ')' ELSE '' END);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
