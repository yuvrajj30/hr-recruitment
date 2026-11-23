-- Row-level security (RLS): the database itself decides which rows the app may see or change.
--
-- How it works
--   * Before running its queries, the app records who is asking, inside the same transaction:
--       app.mode    'staff' (a signed-in member) or 'public_apply' (the public careers form)
--       app.user_id the signed-in user (staff only)
--       app.org_id  the organisation (staff: from the session; public: the job's organisation)
--     These settings disappear when the transaction ends, so nothing carries over between requests.
--   * The member's ROLE is never taken from the app: the database looks it up from the active membership
--     (app_staff_role), so a wrong or forged role in the app cannot widen access.
--   * Policies apply to the app's restricted account (hr_runtime). The owner account (hr_app), used only
--     by migrations, the seed and test set-up, owns the tables and is not affected.
--   * Nothing set = nothing visible on protected tables ("deny by default"), so a query that forgets to
--     say who is asking fails loudly instead of returning someone else's data.
--
-- Not covered here (on purpose): users, sessions, auth_login_attempts, organizations, roles, permissions,
-- role_permissions. Sign-in and session checks must read these BEFORE anyone is known; they stay protected
-- by the application checks and the restricted account's rights, as before.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Who is asking
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_setting"(name TEXT) RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.' || name, true), '');
$$ LANGUAGE sql STABLE;

CREATE FUNCTION "app_mode"() RETURNS TEXT AS $$ SELECT "app_setting"('mode'); $$ LANGUAGE sql STABLE;
CREATE FUNCTION "app_user_id"() RETURNS UUID AS $$ SELECT "app_setting"('user_id')::UUID; $$ LANGUAGE sql STABLE;
CREATE FUNCTION "app_org_id"() RETURNS UUID AS $$ SELECT "app_setting"('org_id')::UUID; $$ LANGUAGE sql STABLE;

-- The asking member's role, looked up from the database (not trusted from the app): only an ACTIVE member
-- of an ACTIVE organisation, whose user account is ACTIVE, has a role here. SECURITY DEFINER lets it read
-- the membership tables regardless of their own policies; it reads only the caller's own membership.
CREATE FUNCTION "app_staff_role"() RETURNS TEXT AS $$
  SELECT r."key"
  FROM "organization_members" om
  JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
  JOIN "roles" r ON r."id" = omr."role_id"
  JOIN "users" u ON u."id" = om."user_id"
  JOIN "organizations" o ON o."id" = om."organization_id"
  WHERE "app_mode"() = 'staff'
    AND om."user_id" = "app_user_id"() AND om."organization_id" = "app_org_id"()
    AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND o."status" = 'ACTIVE'
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE FUNCTION "app_is_hr"() RETURNS BOOLEAN AS $$
  SELECT COALESCE("app_staff_role"() IN ('SUPER_ADMIN', 'HR_MANAGER'), false);
$$ LANGUAGE sql STABLE;

CREATE FUNCTION "app_is_super_admin"() RETURNS BOOLEAN AS $$
  SELECT COALESCE("app_staff_role"() = 'SUPER_ADMIN', false);
$$ LANGUAGE sql STABLE;

-- The organisation a public application is being made to (only in public mode).
CREATE FUNCTION "app_public_org_id"() RETURNS UUID AS $$
  SELECT CASE WHEN "app_mode"() = 'public_apply' THEN "app_org_id"() END;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 2. HR work: Super Admins and HR Managers of the SAME organisation; nobody else
-- ---------------------------------------------------------------------------
-- "(SELECT app_is_hr())" is evaluated once per query, not once per row.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments', 'job_openings', 'job_recruiters',
    'organization_candidates', 'applications', 'application_status_history', 'application_notes',
    'application_assignments', 'candidate_documents', 'application_documents',
    'form_templates', 'form_fields', 'form_assignments', 'form_submissions', 'form_answers',
    'interviews', 'interview_participants', 'interview_feedback', 'hiring_decisions', 'offers',
    'onboarding_records', 'onboarding_documents', 'notifications'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "hr_same_org" ON %I FOR ALL USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_hr"())) '
      'WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_is_hr"()))', t);
  END LOOP;
END;
$$;

-- System integrations and API clients: Super Admins only.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_clients', 'integration_connections', 'integration_sync_jobs', 'integration_sync_errors',
    'external_employee_links', 'external_entity_mappings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "super_admin_same_org" ON %I FOR ALL USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"())) '
      'WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()))', t);
  END LOOP;
END;
$$;

-- An employee reads (and marks as read) only their OWN notifications.
CREATE POLICY "own_notifications_read" ON "notifications" FOR SELECT
  USING ("app_mode"() = 'staff' AND "organization_id" = "app_org_id"() AND "recipient_user_id" = "app_user_id"() AND (SELECT "app_staff_role"()) IS NOT NULL);
CREATE POLICY "own_notifications_update" ON "notifications" FOR UPDATE
  USING ("app_mode"() = 'staff' AND "organization_id" = "app_org_id"() AND "recipient_user_id" = "app_user_id"() AND (SELECT "app_staff_role"()) IS NOT NULL)
  WITH CHECK ("app_mode"() = 'staff' AND "organization_id" = "app_org_id"() AND "recipient_user_id" = "app_user_id"());

-- ---------------------------------------------------------------------------
-- 3. The public careers form ('public_apply')
-- ---------------------------------------------------------------------------
-- May read only published, public jobs (and the names of their departments).
CREATE POLICY "public_published_jobs" ON "job_openings" FOR SELECT
  USING ("app_mode"() = 'public_apply' AND "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC');
CREATE POLICY "public_job_departments" ON "departments" FOR SELECT
  USING ("app_mode"() = 'public_apply' AND EXISTS (
    SELECT 1 FROM "job_openings" j WHERE j."department_id" = "departments"."id" AND j."status" = 'PUBLISHED' AND j."visibility" = 'PUBLIC'));

-- While submitting, may add the application's rows to the job's organisation, and read back only that
-- organisation's candidate/application rows it needs for the duplicate check. It can never update an
-- application, read notes or assignments, or touch any other organisation.
CREATE POLICY "public_read" ON "organization_candidates" FOR SELECT USING ("organization_id" = "app_public_org_id"());
CREATE POLICY "public_insert" ON "organization_candidates" FOR INSERT WITH CHECK ("organization_id" = "app_public_org_id"());
CREATE POLICY "public_upsert" ON "organization_candidates" FOR UPDATE USING ("organization_id" = "app_public_org_id"()) WITH CHECK ("organization_id" = "app_public_org_id"());

CREATE POLICY "public_read" ON "applications" FOR SELECT USING ("organization_id" = "app_public_org_id"());
-- A new application always starts at "Applied", unassigned, and not marked as entered by staff.
CREATE POLICY "public_insert" ON "applications" FOR INSERT
  WITH CHECK ("organization_id" = "app_public_org_id"() AND "stage" = 'APPLIED' AND "assigned_recruiter_id" IS NULL AND "created_by_id" IS NULL
              AND EXISTS (SELECT 1 FROM "job_openings" j WHERE j."id" = "job_id" AND j."organization_id" = "applications"."organization_id"
                          AND j."status" = 'PUBLISHED' AND j."visibility" = 'PUBLIC'
                          AND (j."application_deadline" IS NULL OR j."application_deadline" > now())));

CREATE POLICY "public_read" ON "application_status_history" FOR SELECT USING ("organization_id" = "app_public_org_id"());
CREATE POLICY "public_insert" ON "application_status_history" FOR INSERT
  WITH CHECK ("organization_id" = "app_public_org_id"() AND "from_stage" IS NULL AND "to_stage" = 'APPLIED' AND "changed_by_id" IS NULL);

CREATE POLICY "public_read" ON "candidate_documents" FOR SELECT USING ("organization_id" = "app_public_org_id"());
CREATE POLICY "public_insert" ON "candidate_documents" FOR INSERT
  WITH CHECK ("organization_id" = "app_public_org_id"() AND "kind" = 'RESUME' AND "application_id" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. Candidate profiles (shared by all organisations: one profile per email)
-- ---------------------------------------------------------------------------
-- Staff see a profile only if that person applied to THEIR organisation. The public form cannot read
-- profiles at all; matching an email to a profile goes through the narrow function below.
ALTER TABLE "candidate_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_educations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_experiences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_skills" ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION "app_candidate_in_my_org"(candidate UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM "organization_candidates" oc WHERE oc."candidate_id" = candidate AND oc."organization_id" = "app_org_id"());
$$ LANGUAGE sql STABLE;

CREATE POLICY "hr_my_candidates" ON "candidate_profiles" FOR SELECT USING ((SELECT "app_is_hr"()) AND "app_candidate_in_my_org"("id"));
CREATE POLICY "hr_my_candidates" ON "candidate_educations" FOR SELECT USING ((SELECT "app_is_hr"()) AND "app_candidate_in_my_org"("candidate_id"));
CREATE POLICY "hr_my_candidates" ON "candidate_experiences" FOR SELECT USING ((SELECT "app_is_hr"()) AND "app_candidate_in_my_org"("candidate_id"));
CREATE POLICY "hr_my_candidates" ON "candidate_skills" FOR SELECT USING ((SELECT "app_is_hr"()) AND "app_candidate_in_my_org"("candidate_id"));

-- Finds the profile for an email, or creates it (with education, experience and skills) if it is new.
-- Returns only the profile's id and whether it was new: never another organisation's details.
-- Callable only by the public careers form or by HR staff, and only for their own organisation.
-- An existing profile is never changed (nobody has proved they own that email address).
CREATE FUNCTION "app_find_or_create_candidate_profile"(
  p_email TEXT, p_full_name TEXT, p_phone TEXT, p_city TEXT, p_linkedin_url TEXT, p_portfolio_url TEXT,
  p_education JSONB, p_experience JSONB, p_skills TEXT[]
) RETURNS TABLE ("id" UUID, "created" BOOLEAN) AS $$
DECLARE
  v_id UUID;
  v_created BOOLEAN := false;
BEGIN
  IF NOT ("app_public_org_id"() IS NOT NULL OR "app_is_hr"()) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
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
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION "app_find_or_create_candidate_profile"(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_find_or_create_candidate_profile"(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT[]) TO hr_runtime;

-- The candidate portal (accounts, sign-in codes, sessions) is not built yet: closed to the app entirely.
ALTER TABLE "candidate_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_login_tokens" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Members, roles and invitations
-- ---------------------------------------------------------------------------
ALTER TABLE "organization_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_member_roles" ENABLE ROW LEVEL SECURITY;

-- Sign-in, session checks and loading a member's permissions happen before anyone is known, with no
-- context set. That path keeps working as before. Once a request says who it is, the rules tighten:
CREATE POLICY "identity_lookup" ON "organization_members" FOR ALL USING ("app_mode"() IS NULL) WITH CHECK ("app_mode"() IS NULL);
CREATE POLICY "identity_lookup" ON "organization_member_roles" FOR ALL USING ("app_mode"() IS NULL) WITH CHECK ("app_mode"() IS NULL);
--   HR staff see the members of their own organisation,
CREATE POLICY "hr_same_org" ON "organization_members" FOR SELECT USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "organization_member_roles" FOR SELECT
  USING ((SELECT "app_is_hr"()) AND EXISTS (SELECT 1 FROM "organization_members" om WHERE om."id" = "member_id" AND om."organization_id" = "app_org_id"()));
--   and everyone (an Employee included) sees ONLY their own membership row.
CREATE POLICY "own_membership" ON "organization_members" FOR SELECT
  USING ("app_mode"() = 'staff' AND "user_id" = "app_user_id"() AND "organization_id" = "app_org_id"());
CREATE POLICY "own_membership" ON "organization_member_roles" FOR SELECT
  USING ("app_mode"() = 'staff' AND EXISTS (SELECT 1 FROM "organization_members" om WHERE om."id" = "member_id" AND om."user_id" = "app_user_id"() AND om."organization_id" = "app_org_id"()));

-- Invitations: Super Admins handle all of their organisation's; HR Managers only Employee invitations.
ALTER TABLE "staff_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "super_admin_same_org" ON "staff_invitations" FOR ALL
  USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()))
  WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()));
CREATE POLICY "hr_employee_invitations" ON "staff_invitations" FOR ALL
  USING ("organization_id" = "app_org_id"() AND (SELECT "app_staff_role"()) = 'HR_MANAGER' AND "role_key" = 'EMPLOYEE')
  WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_staff_role"()) = 'HR_MANAGER' AND "role_key" = 'EMPLOYEE');

-- ---------------------------------------------------------------------------
-- 6. Safety triggers must see ALL rows, whoever is asking
-- ---------------------------------------------------------------------------
-- The last-Super-Admin, ownership and document-ownership checks read members, roles and documents. Under
-- row security they would otherwise see only what the asking person may see (an Employee sees only their
-- own membership) and could miscount. They read with the owner's rights instead; they only ever answer
-- "is this change allowed?", never return data.
ALTER FUNCTION "org_active_super_admins"(UUID) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION "member_is_super_admin"(UUID) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION "role_is_super_admin"(UUID) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION "guard_last_super_admin"() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION "guard_owner_is_super_admin"() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION "check_application_document_owner"() SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------------
-- 7. Audit log: anyone may add a record; only a Super Admin of the organisation may read them
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_appends" ON "audit_logs" FOR INSERT WITH CHECK (true);
CREATE POLICY "super_admin_reads" ON "audit_logs" FOR SELECT USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()));

COMMIT;
