-- User management: who may change memberships, roles and the organisation's settings, enforced by the
-- database (row-level security) in addition to the application's checks.
--
--   * Super Admins may change the status and role of anyone in their organisation, except themselves.
--   * HR Managers may only deactivate / reactivate EMPLOYEES of their organisation. They cannot change
--     anyone's role, and cannot touch Super Admins or other HR Managers.
--   * Nobody can change their own membership or role through the app.
--   * The organisation owner always stays an active Super Admin (until an ownership transfer exists).
--   * Only a Super Admin may change organisation settings (for example "HR may invite Employees").
-- Everything else from the earlier migrations (last Super Admin protection, one role per member,
-- exactly three roles) still applies.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Small helpers (read with the owner's rights; they only answer questions about one member)
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_member_role_key"(member UUID) RETURNS TEXT AS $$
  SELECT r."key" FROM "organization_member_roles" omr JOIN "roles" r ON r."id" = omr."role_id" WHERE omr."member_id" = member LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE FUNCTION "app_member_org"(member UUID) RETURNS UUID AS $$
  SELECT om."organization_id" FROM "organization_members" om WHERE om."id" = member;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE FUNCTION "app_member_user"(member UUID) RETURNS UUID AS $$
  SELECT om."user_id" FROM "organization_members" om WHERE om."id" = member;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------------
-- 2. Memberships: activate / deactivate
-- ---------------------------------------------------------------------------
CREATE POLICY "super_admin_manages_members" ON "organization_members" FOR UPDATE
  USING ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()) AND "user_id" <> "app_user_id"())
  WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_is_super_admin"()) AND "user_id" <> "app_user_id"());

CREATE POLICY "hr_manages_employees" ON "organization_members" FOR UPDATE
  USING ("organization_id" = "app_org_id"() AND (SELECT "app_staff_role"()) = 'HR_MANAGER'
         AND "user_id" <> "app_user_id"() AND "app_member_role_key"("id") = 'EMPLOYEE')
  WITH CHECK ("organization_id" = "app_org_id"() AND (SELECT "app_staff_role"()) = 'HR_MANAGER'
         AND "user_id" <> "app_user_id"() AND "app_member_role_key"("id") = 'EMPLOYEE');

-- ---------------------------------------------------------------------------
-- 3. Roles: only a Super Admin, never for themselves
-- ---------------------------------------------------------------------------
CREATE POLICY "super_admin_changes_roles" ON "organization_member_roles" FOR UPDATE
  USING ((SELECT "app_is_super_admin"()) AND "app_member_org"("member_id") = "app_org_id"() AND "app_member_user"("member_id") <> "app_user_id"())
  WITH CHECK ((SELECT "app_is_super_admin"()) AND "app_member_org"("member_id") = "app_org_id"() AND "app_member_user"("member_id") <> "app_user_id"());

-- ---------------------------------------------------------------------------
-- 4. The owner always stays an active Super Admin
-- ---------------------------------------------------------------------------
-- Extends the last-Super-Admin check: if the changed membership / role / account belongs to the
-- organisation's owner, the owner must still be an active Super Admin at the end of the transaction.
CREATE OR REPLACE FUNCTION "guard_last_super_admin"() RETURNS trigger AS $$
DECLARE
  org UUID;
  orgs UUID[];
  changed_user UUID;
BEGIN
  IF TG_TABLE_NAME = 'organization_members' THEN
    orgs := ARRAY[OLD."organization_id"];
    changed_user := OLD."user_id";
  ELSIF TG_TABLE_NAME = 'organization_member_roles' THEN
    orgs := ARRAY(SELECT om."organization_id" FROM "organization_members" om WHERE om."id" = OLD."member_id");
    changed_user := (SELECT om."user_id" FROM "organization_members" om WHERE om."id" = OLD."member_id");
  ELSIF TG_TABLE_NAME = 'users' THEN
    orgs := ARRAY(SELECT om."organization_id" FROM "organization_members" om
                  WHERE om."user_id" = OLD."id" AND om."status" = 'ACTIVE' AND "member_is_super_admin"(om."id"));
    changed_user := OLD."id";
  END IF;
  FOREACH org IN ARRAY COALESCE(orgs, ARRAY[]::UUID[]) LOOP
    IF EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = org)
       AND EXISTS (SELECT 1 FROM "organization_members" om WHERE om."organization_id" = org) THEN
      IF "org_active_super_admins"(org) = 0 THEN
        RAISE EXCEPTION 'an organisation must keep at least one active Super Admin' USING ERRCODE = 'check_violation';
      END IF;
      IF changed_user IS NOT NULL AND EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = org AND o."owner_user_id" = changed_user)
         AND NOT EXISTS (
           SELECT 1 FROM "organization_members" om
           JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
           JOIN "roles" r ON r."id" = omr."role_id"
           JOIN "users" u ON u."id" = om."user_id"
           WHERE om."organization_id" = org AND om."user_id" = changed_user
             AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND r."key" = 'SUPER_ADMIN') THEN
        RAISE EXCEPTION 'the organisation owner must stay an active Super Admin' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------------
-- 5. Organisation settings: only a Super Admin may change them
-- ---------------------------------------------------------------------------
-- Sign-in, session checks and the organisation list read organisations before anyone is known (no
-- context): unchanged. The public careers pages read active organisations. Staff read their own
-- organisation; only its Super Admin may update it.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "identity_lookup" ON "organizations" FOR ALL USING ("app_mode"() IS NULL) WITH CHECK ("app_mode"() IS NULL);
CREATE POLICY "public_active" ON "organizations" FOR SELECT USING ("app_mode"() = 'public_apply' AND "status" = 'ACTIVE');
CREATE POLICY "staff_own_org" ON "organizations" FOR SELECT USING ("app_mode"() = 'staff' AND "id" = "app_org_id"());
CREATE POLICY "super_admin_updates_org" ON "organizations" FOR UPDATE
  USING ("id" = "app_org_id"() AND (SELECT "app_is_super_admin"()))
  WITH CHECK ("id" = "app_org_id"() AND (SELECT "app_is_super_admin"()));

COMMIT;
