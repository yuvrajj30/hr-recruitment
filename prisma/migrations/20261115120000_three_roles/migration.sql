-- Three roles: SUPER_ADMIN, HR_MANAGER and EMPLOYEE (approved 2026-11-15).
--
-- What this does, in ONE transaction (if any statement fails, nothing is kept):
--   1. Brings the permission list up to date (adds user, employee, attendance, leave and self-service
--      permissions; removes the "assigned only" and old member:* permissions).
--   2. Renames the ADMIN role to SUPER_ADMIN on the SAME row, so existing Super Admins keep their
--      membership, login, sessions and organisation ownership. Adds EMPLOYEE.
--   3. Gives every member exactly one of the three roles. Members who held only RECRUITER or
--      INTERVIEWER become EMPLOYEE and their membership is SUSPENDED (nothing is deleted).
--   4. Clears a "responsible HR person" on applications when that person is no longer an active
--      Super Admin or HR Manager, writing a new history row (old history rows are kept).
--   5. Deletes the RECRUITER and INTERVIEWER roles and rebuilds each role's permissions.
--   6. Adds database rules: only the three role keys may exist; one role per member; an organisation
--      can never lose its last active Super Admin; ownership can only pass to an active Super Admin.
--   7. Adds staff invitations and the "HR may invite Employees" organisation setting.
--   8. Ends the sessions of members whose role or status changed, and writes audit rows.
BEGIN;

LOCK TABLE "roles", "permissions", "role_permissions", "organization_member_roles", "organization_members" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_m_permissions" ("key" TEXT PRIMARY KEY, "module" TEXT NOT NULL, "description" TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO "_m_permissions" ("key", "module", "description") VALUES
  ('org:read', 'organization', 'View company settings'),
  ('org:update', 'organization', 'Change company settings'),
  ('settings:security', 'organization', 'Change security settings'),
  ('integration:read', 'integration', 'View integration status'),
  ('integration:manage', 'integration', 'Manage CafeOS integration and API clients'),
  ('audit:read', 'audit', 'View the audit log'),
  ('user:read', 'user', 'View team members and their accounts'),
  ('user:invite_employee', 'user', 'Invite Employee accounts'),
  ('user:manage_employee', 'user', 'Deactivate and reactivate Employee accounts'),
  ('user:invite_hr', 'user', 'Invite HR Manager accounts'),
  ('user:manage_hr', 'user', 'Change, deactivate and reactivate HR Manager accounts'),
  ('user:manage_super_admin', 'user', 'Grant, change and deactivate Super Admin access'),
  ('department:read', 'department', 'View departments'),
  ('department:manage', 'department', 'Create, edit and remove departments'),
  ('job:read', 'job', 'View job openings'),
  ('job:create', 'job', 'Create job openings'),
  ('job:update', 'job', 'Edit job openings'),
  ('job:publish', 'job', 'Publish or unpublish job openings'),
  ('job:close', 'job', 'Close job openings'),
  ('job:delete', 'job', 'Delete job openings'),
  ('candidate:read', 'candidate', 'View candidates'),
  ('candidate:create', 'candidate', 'Add candidates manually'),
  ('candidate:update', 'candidate', 'Edit candidate details and notes'),
  ('candidate:delete', 'candidate', 'Delete candidates'),
  ('application:read', 'application', 'View applications'),
  ('application:create', 'application', 'Create applications on behalf of candidates'),
  ('application:move_stage', 'application', 'Move applications between stages'),
  ('application:assign', 'application', 'Choose the HR person responsible for an application'),
  ('application:note', 'application', 'Add internal notes'),
  ('document:read', 'document', 'View and download candidate documents'),
  ('form:read', 'form', 'View form templates'),
  ('form:manage', 'form', 'Create and edit form templates'),
  ('form:assign', 'form', 'Send forms to candidates'),
  ('interview:read', 'interview', 'View interviews'),
  ('interview:schedule', 'interview', 'Schedule interviews'),
  ('interview:update', 'interview', 'Reschedule or edit interviews'),
  ('interview:cancel', 'interview', 'Cancel interviews'),
  ('feedback:submit', 'feedback', 'Submit interview feedback'),
  ('feedback:read', 'feedback', 'Read interview feedback'),
  ('decision:read', 'decision', 'View hiring decisions'),
  ('decision:make', 'decision', 'Record hiring decisions'),
  ('offer:read', 'offer', 'View offers'),
  ('offer:create', 'offer', 'Draft offers'),
  ('offer:issue', 'offer', 'Issue offers to candidates'),
  ('offer:withdraw', 'offer', 'Withdraw offers'),
  ('onboarding:read', 'onboarding', 'View onboarding records'),
  ('onboarding:manage', 'onboarding', 'Manage onboarding tasks and documents'),
  ('onboarding:approve', 'onboarding', 'Approve onboarding (triggers the CafeOS transfer)'),
  ('employee:read', 'employee', 'View employee records'),
  ('employee:manage', 'employee', 'Create and edit employee records'),
  ('assignment:manage', 'employee', 'Manage employee job and designation assignments'),
  ('attendance:read', 'attendance', 'View everyone''s attendance'),
  ('attendance:manage', 'attendance', 'Correct and manage attendance records'),
  ('leave:read', 'leave', 'View everyone''s leave requests'),
  ('leave:approve', 'leave', 'Approve or reject leave requests'),
  ('report:read', 'report', 'View HR reports and dashboards'),
  ('self:profile_read', 'self', 'View my own employee profile and work information'),
  ('self:profile_update', 'self', 'Update my permitted personal details'),
  ('self:attendance_read', 'self', 'View my own attendance'),
  ('self:leave_apply', 'self', 'Apply for leave'),
  ('self:leave_read', 'self', 'View my own leave balance and requests'),
  ('notification:read', 'self', 'Receive my notifications');

INSERT INTO "permissions" ("id", "key", "module", "description")
SELECT gen_random_uuid(), p."key", p."module", p."description" FROM "_m_permissions" p
ON CONFLICT ("key") DO UPDATE SET "module" = EXCLUDED."module", "description" = EXCLUDED."description";

-- ---------------------------------------------------------------------------
-- 2. Roles: rename ADMIN in place, then make sure all three exist
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_m_roles" ("key" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT NOT NULL, "rank" INT) ON COMMIT DROP;
INSERT INTO "_m_roles" ("key", "name", "description") VALUES
  ('SUPER_ADMIN', 'Super Admin', 'Complete control of the organisation: users, roles, settings, security and every module'),
  ('HR_MANAGER', 'HR Manager', 'Runs day-to-day HR: recruitment, employees, attendance and leave; cannot change system settings or Super Admins'),
  ('EMPLOYEE', 'Employee', 'Self-service only: their own profile, work information, attendance and leave');
UPDATE "_m_roles" SET "rank" = CASE "key" WHEN 'SUPER_ADMIN' THEN 3 WHEN 'HR_MANAGER' THEN 2 ELSE 1 END;

-- What every member holds BEFORE any change (for the decision and the audit trail).
CREATE TEMP TABLE "_m_before" ON COMMIT DROP AS
SELECT om."id" AS "member_id", om."organization_id", om."user_id", om."status" AS "old_status",
       COALESCE(array_agg(r."key" ORDER BY r."key") FILTER (WHERE r."key" IS NOT NULL), ARRAY[]::TEXT[]) AS "old_roles"
FROM "organization_members" om
LEFT JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
LEFT JOIN "roles" r ON r."id" = omr."role_id"
GROUP BY om."id", om."organization_id", om."user_id", om."status";

UPDATE "roles" SET "key" = 'SUPER_ADMIN'
WHERE "key" = 'ADMIN' AND NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'SUPER_ADMIN');

INSERT INTO "roles" ("id", "key", "name", "description", "is_system")
SELECT gen_random_uuid(), r."key", r."name", r."description", true FROM "_m_roles" r
ON CONFLICT ("key") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "is_system" = true;

-- ---------------------------------------------------------------------------
-- 3. Exactly one role per member
-- ---------------------------------------------------------------------------
-- The one role each member keeps: the highest of the three they already hold (ADMIN counts as
-- SUPER_ADMIN). Anyone holding none of the three (only RECRUITER / INTERVIEWER, or no role at all)
-- gets EMPLOYEE, the least access.
CREATE TEMP TABLE "_m_target" ON COMMIT DROP AS
SELECT b."member_id", b."organization_id", b."user_id", b."old_status", b."old_roles",
       COALESCE((SELECT mr."key" FROM "_m_roles" mr WHERE mr."key" = ANY (array_replace(b."old_roles", 'ADMIN', 'SUPER_ADMIN')) ORDER BY mr."rank" DESC LIMIT 1), 'EMPLOYEE') AS "new_role",
       (b."old_roles" && ARRAY['RECRUITER', 'INTERVIEWER']
        AND NOT (array_replace(b."old_roles", 'ADMIN', 'SUPER_ADMIN') && ARRAY['SUPER_ADMIN', 'HR_MANAGER'])
        AND b."old_status" <> 'SUSPENDED') AS "suspend"
FROM "_m_before" b;

DELETE FROM "organization_member_roles" omr
USING "_m_target" t, "roles" r
WHERE omr."member_id" = t."member_id" AND r."id" = omr."role_id" AND r."key" <> t."new_role";

INSERT INTO "organization_member_roles" ("member_id", "role_id")
SELECT t."member_id", r."id" FROM "_m_target" t JOIN "roles" r ON r."key" = t."new_role"
ON CONFLICT DO NOTHING;

-- Former Recruiters / Interviewers: kept, but suspended (approved decision 4).
UPDATE "organization_members" om SET "status" = 'SUSPENDED', "updated_at" = CURRENT_TIMESTAMP
FROM "_m_target" t WHERE om."id" = t."member_id" AND t."suspend";

-- ---------------------------------------------------------------------------
-- 4. The responsible HR person must be an active Super Admin or HR Manager
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_m_unassigned" ON COMMIT DROP AS
SELECT a."id" AS "application_id", a."organization_id", a."assigned_recruiter_id" AS "previous"
FROM "applications" a
WHERE a."assigned_recruiter_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
    JOIN "roles" r ON r."id" = omr."role_id"
    JOIN "users" u ON u."id" = om."user_id"
    WHERE om."organization_id" = a."organization_id" AND om."user_id" = a."assigned_recruiter_id"
      AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND r."key" IN ('SUPER_ADMIN', 'HR_MANAGER'));

UPDATE "applications" a SET "assigned_recruiter_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
FROM "_m_unassigned" x WHERE a."id" = x."application_id";

-- A NEW history row (recruiter empty = unassigned, assigned_by empty = done by the system).
-- Earlier history rows are never changed.
INSERT INTO "application_assignments" ("id", "organization_id", "application_id", "recruiter_id", "assigned_by_id")
SELECT gen_random_uuid(), x."organization_id", x."application_id", NULL, NULL FROM "_m_unassigned" x;

-- ---------------------------------------------------------------------------
-- 5. Remove the old roles and permissions; rebuild each role's permissions exactly
-- ---------------------------------------------------------------------------
DELETE FROM "roles" WHERE "key" NOT IN (SELECT "key" FROM "_m_roles");
DELETE FROM "permissions" WHERE "key" NOT IN (SELECT "key" FROM "_m_permissions");

CREATE TEMP TABLE "_m_role_permissions" ("role_key" TEXT NOT NULL, "permission_key" TEXT NOT NULL, PRIMARY KEY ("role_key", "permission_key")) ON COMMIT DROP;
INSERT INTO "_m_role_permissions" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'org:read'),
  ('SUPER_ADMIN', 'org:update'),
  ('SUPER_ADMIN', 'settings:security'),
  ('SUPER_ADMIN', 'integration:read'),
  ('SUPER_ADMIN', 'integration:manage'),
  ('SUPER_ADMIN', 'audit:read'),
  ('SUPER_ADMIN', 'user:read'),
  ('SUPER_ADMIN', 'user:invite_employee'),
  ('SUPER_ADMIN', 'user:manage_employee'),
  ('SUPER_ADMIN', 'user:invite_hr'),
  ('SUPER_ADMIN', 'user:manage_hr'),
  ('SUPER_ADMIN', 'user:manage_super_admin'),
  ('SUPER_ADMIN', 'department:read'),
  ('SUPER_ADMIN', 'department:manage'),
  ('SUPER_ADMIN', 'job:read'),
  ('SUPER_ADMIN', 'job:create'),
  ('SUPER_ADMIN', 'job:update'),
  ('SUPER_ADMIN', 'job:publish'),
  ('SUPER_ADMIN', 'job:close'),
  ('SUPER_ADMIN', 'job:delete'),
  ('SUPER_ADMIN', 'candidate:read'),
  ('SUPER_ADMIN', 'candidate:create'),
  ('SUPER_ADMIN', 'candidate:update'),
  ('SUPER_ADMIN', 'candidate:delete'),
  ('SUPER_ADMIN', 'application:read'),
  ('SUPER_ADMIN', 'application:create'),
  ('SUPER_ADMIN', 'application:move_stage'),
  ('SUPER_ADMIN', 'application:assign'),
  ('SUPER_ADMIN', 'application:note'),
  ('SUPER_ADMIN', 'document:read'),
  ('SUPER_ADMIN', 'form:read'),
  ('SUPER_ADMIN', 'form:manage'),
  ('SUPER_ADMIN', 'form:assign'),
  ('SUPER_ADMIN', 'interview:read'),
  ('SUPER_ADMIN', 'interview:schedule'),
  ('SUPER_ADMIN', 'interview:update'),
  ('SUPER_ADMIN', 'interview:cancel'),
  ('SUPER_ADMIN', 'feedback:submit'),
  ('SUPER_ADMIN', 'feedback:read'),
  ('SUPER_ADMIN', 'decision:read'),
  ('SUPER_ADMIN', 'decision:make'),
  ('SUPER_ADMIN', 'offer:read'),
  ('SUPER_ADMIN', 'offer:create'),
  ('SUPER_ADMIN', 'offer:issue'),
  ('SUPER_ADMIN', 'offer:withdraw'),
  ('SUPER_ADMIN', 'onboarding:read'),
  ('SUPER_ADMIN', 'onboarding:manage'),
  ('SUPER_ADMIN', 'onboarding:approve'),
  ('SUPER_ADMIN', 'employee:read'),
  ('SUPER_ADMIN', 'employee:manage'),
  ('SUPER_ADMIN', 'assignment:manage'),
  ('SUPER_ADMIN', 'attendance:read'),
  ('SUPER_ADMIN', 'attendance:manage'),
  ('SUPER_ADMIN', 'leave:read'),
  ('SUPER_ADMIN', 'leave:approve'),
  ('SUPER_ADMIN', 'report:read'),
  ('SUPER_ADMIN', 'self:profile_read'),
  ('SUPER_ADMIN', 'self:profile_update'),
  ('SUPER_ADMIN', 'self:attendance_read'),
  ('SUPER_ADMIN', 'self:leave_apply'),
  ('SUPER_ADMIN', 'self:leave_read'),
  ('SUPER_ADMIN', 'notification:read'),
  ('HR_MANAGER', 'org:read'),
  ('HR_MANAGER', 'user:read'),
  ('HR_MANAGER', 'user:invite_employee'),
  ('HR_MANAGER', 'user:manage_employee'),
  ('HR_MANAGER', 'department:read'),
  ('HR_MANAGER', 'department:manage'),
  ('HR_MANAGER', 'job:read'),
  ('HR_MANAGER', 'job:create'),
  ('HR_MANAGER', 'job:update'),
  ('HR_MANAGER', 'job:publish'),
  ('HR_MANAGER', 'job:close'),
  ('HR_MANAGER', 'candidate:read'),
  ('HR_MANAGER', 'candidate:create'),
  ('HR_MANAGER', 'candidate:update'),
  ('HR_MANAGER', 'application:read'),
  ('HR_MANAGER', 'application:create'),
  ('HR_MANAGER', 'application:move_stage'),
  ('HR_MANAGER', 'application:assign'),
  ('HR_MANAGER', 'application:note'),
  ('HR_MANAGER', 'document:read'),
  ('HR_MANAGER', 'form:read'),
  ('HR_MANAGER', 'form:manage'),
  ('HR_MANAGER', 'form:assign'),
  ('HR_MANAGER', 'interview:read'),
  ('HR_MANAGER', 'interview:schedule'),
  ('HR_MANAGER', 'interview:update'),
  ('HR_MANAGER', 'interview:cancel'),
  ('HR_MANAGER', 'feedback:submit'),
  ('HR_MANAGER', 'feedback:read'),
  ('HR_MANAGER', 'decision:read'),
  ('HR_MANAGER', 'decision:make'),
  ('HR_MANAGER', 'offer:read'),
  ('HR_MANAGER', 'offer:create'),
  ('HR_MANAGER', 'offer:issue'),
  ('HR_MANAGER', 'offer:withdraw'),
  ('HR_MANAGER', 'onboarding:read'),
  ('HR_MANAGER', 'onboarding:manage'),
  ('HR_MANAGER', 'onboarding:approve'),
  ('HR_MANAGER', 'employee:read'),
  ('HR_MANAGER', 'employee:manage'),
  ('HR_MANAGER', 'assignment:manage'),
  ('HR_MANAGER', 'attendance:read'),
  ('HR_MANAGER', 'attendance:manage'),
  ('HR_MANAGER', 'leave:read'),
  ('HR_MANAGER', 'leave:approve'),
  ('HR_MANAGER', 'report:read'),
  ('HR_MANAGER', 'self:profile_read'),
  ('HR_MANAGER', 'self:profile_update'),
  ('HR_MANAGER', 'self:attendance_read'),
  ('HR_MANAGER', 'self:leave_apply'),
  ('HR_MANAGER', 'self:leave_read'),
  ('HR_MANAGER', 'notification:read'),
  ('EMPLOYEE', 'self:profile_read'),
  ('EMPLOYEE', 'self:profile_update'),
  ('EMPLOYEE', 'self:attendance_read'),
  ('EMPLOYEE', 'self:leave_apply'),
  ('EMPLOYEE', 'self:leave_read'),
  ('EMPLOYEE', 'notification:read');

DELETE FROM "role_permissions" rp USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  AND NOT EXISTS (SELECT 1 FROM "_m_role_permissions" x WHERE x."role_key" = r."key" AND x."permission_key" = p."key");

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "_m_role_permissions" x
JOIN "roles" r ON r."key" = x."role_key"
JOIN "permissions" p ON p."key" = x."permission_key"
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Database rules
-- ---------------------------------------------------------------------------
-- Only the three role keys can ever exist.
ALTER TABLE "roles" ADD CONSTRAINT "roles_only_three" CHECK ("key" IN ('SUPER_ADMIN', 'HR_MANAGER', 'EMPLOYEE'));

-- One role per member.
CREATE UNIQUE INDEX "organization_member_roles_member_id_key" ON "organization_member_roles"("member_id");

-- How many active Super Admins an organisation has.
CREATE FUNCTION "org_active_super_admins"(org UUID) RETURNS BIGINT AS $$
  SELECT count(*) FROM "organization_members" om
  JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
  JOIN "roles" r ON r."id" = omr."role_id"
  JOIN "users" u ON u."id" = om."user_id"
  WHERE om."organization_id" = org AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND r."key" = 'SUPER_ADMIN';
$$ LANGUAGE sql STABLE;

-- Refuses a change that leaves an organisation without an active Super Admin. It runs at the END of the
-- transaction (deferred), so a role can be swapped (remove + add) inside one transaction. Removing every
-- member of an organisation at once (a full teardown) is still allowed.
CREATE FUNCTION "guard_last_super_admin"() RETURNS trigger AS $$
DECLARE
  org UUID;
  orgs UUID[];
BEGIN
  IF TG_TABLE_NAME = 'organization_members' THEN
    orgs := ARRAY[OLD."organization_id"];
  ELSIF TG_TABLE_NAME = 'organization_member_roles' THEN
    orgs := ARRAY(SELECT om."organization_id" FROM "organization_members" om WHERE om."id" = OLD."member_id");
  ELSIF TG_TABLE_NAME = 'users' THEN
    orgs := ARRAY(SELECT om."organization_id" FROM "organization_members" om
                  WHERE om."user_id" = OLD."id" AND om."status" = 'ACTIVE' AND "member_is_super_admin"(om."id"));
  END IF;
  FOREACH org IN ARRAY COALESCE(orgs, ARRAY[]::UUID[]) LOOP
    IF EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = org)
       AND EXISTS (SELECT 1 FROM "organization_members" om WHERE om."organization_id" = org)
       AND "org_active_super_admins"(org) = 0 THEN
      RAISE EXCEPTION 'an organisation must keep at least one active Super Admin' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The trigger only needs to look when the row being changed belonged to an active Super Admin, so
-- organisations that never had one (for example, throw-away test data) are not affected.
CREATE FUNCTION "member_is_super_admin"(member UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "organization_member_roles" omr JOIN "roles" r ON r."id" = omr."role_id"
    WHERE omr."member_id" = member AND r."key" = 'SUPER_ADMIN');
$$ LANGUAGE sql STABLE;

CREATE FUNCTION "role_is_super_admin"(role UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM "roles" r WHERE r."id" = role AND r."key" = 'SUPER_ADMIN');
$$ LANGUAGE sql STABLE;

-- A Super Admin membership that stops being active, or is removed.
CREATE CONSTRAINT TRIGGER "organization_members_keep_super_admin"
  AFTER UPDATE OF "status" OR DELETE ON "organization_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" = 'ACTIVE' AND "member_is_super_admin"(OLD."id"))
  EXECUTE FUNCTION "guard_last_super_admin"();

-- A Super Admin role that is taken away or replaced.
CREATE CONSTRAINT TRIGGER "organization_member_roles_keep_super_admin"
  AFTER UPDATE OR DELETE ON "organization_member_roles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN ("role_is_super_admin"(OLD."role_id"))
  EXECUTE FUNCTION "guard_last_super_admin"();

-- A user account that is disabled.
CREATE CONSTRAINT TRIGGER "users_keep_super_admin"
  AFTER UPDATE OF "status" ON "users"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE')
  EXECUTE FUNCTION "guard_last_super_admin"();

-- Ownership can only pass to an active Super Admin of the same organisation.
CREATE FUNCTION "guard_owner_is_super_admin"() RETURNS trigger AS $$
BEGIN
  IF NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id" AND NOT EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
    JOIN "roles" r ON r."id" = omr."role_id"
    JOIN "users" u ON u."id" = om."user_id"
    WHERE om."organization_id" = NEW."id" AND om."user_id" = NEW."owner_user_id"
      AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND r."key" = 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'the organisation owner must be an active Super Admin of the organisation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organizations_owner_is_super_admin"
  BEFORE UPDATE OF "owner_user_id" ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION "guard_owner_is_super_admin"();

-- ---------------------------------------------------------------------------
-- 7. Invitations and the "HR may invite Employees" setting
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ADD COLUMN "hr_can_invite_employees" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "staff_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role_key" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id"),
    -- Invitations are for HR Managers and Employees only; nobody is invited straight in as Super Admin.
    CONSTRAINT "staff_invitations_role" CHECK ("role_key" IN ('HR_MANAGER', 'EMPLOYEE')),
    CONSTRAINT "staff_invitations_email_lower" CHECK ("email" = lower("email")),
    CONSTRAINT "staff_invitations_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "staff_invitations_one_outcome" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL),
    CONSTRAINT "staff_invitations_accepted_user" CHECK (("accepted_at" IS NULL) = ("accepted_user_id" IS NULL))
);

CREATE UNIQUE INDEX "staff_invitations_token_hash_key" ON "staff_invitations"("token_hash");
CREATE INDEX "staff_invitations_organization_id_created_at_idx" ON "staff_invitations"("organization_id", "created_at");
-- At most one open invitation per person per organisation (sending a new one revokes the old one).
CREATE UNIQUE INDEX "staff_invitations_one_open" ON "staff_invitations"("organization_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 8. Sessions and audit trail
-- ---------------------------------------------------------------------------
-- Members whose role or status actually changed. (ADMIN -> SUPER_ADMIN is a rename of the same role,
-- not a change, so existing Super Admins stay signed in.)
CREATE TEMP TABLE "_m_changed" ON COMMIT DROP AS
SELECT t.* FROM "_m_target" t
WHERE t."suspend" OR array_replace(t."old_roles", 'ADMIN', 'SUPER_ADMIN') IS DISTINCT FROM ARRAY[t."new_role"];

UPDATE "sessions" s SET "revoked_at" = CURRENT_TIMESTAMP, "revoked_reason" = 'membership_changed'
FROM "_m_changed" c
WHERE s."user_id" = c."user_id" AND s."revoked_at" IS NULL;

INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "actor_label", "action", "entity_type", "entity_id", "metadata")
SELECT gen_random_uuid(), c."organization_id", NULL, 'migration 20261115120000_three_roles', 'member.role_migrated', 'organization_member', c."member_id"::TEXT,
       jsonb_build_object('from', to_jsonb(c."old_roles"), 'to', c."new_role", 'suspended', c."suspend", 'previousStatus', c."old_status")
FROM "_m_changed" c;

INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "actor_label", "action", "entity_type", "entity_id", "metadata")
SELECT gen_random_uuid(), x."organization_id", NULL, 'migration 20261115120000_three_roles', 'application.unassigned', 'application', x."application_id"::TEXT,
       jsonb_build_object('from', x."previous", 'to', NULL, 'reason', 'responsible person is no longer an active Super Admin or HR Manager')
FROM "_m_unassigned" x;

INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "actor_label", "action", "entity_type", "entity_id", "metadata")
SELECT gen_random_uuid(), o."id", NULL, 'migration 20261115120000_three_roles', 'roles.three_role_structure', 'organization', o."id"::TEXT,
       jsonb_build_object('roles', jsonb_build_array('SUPER_ADMIN', 'HR_MANAGER', 'EMPLOYEE'),
                          'permissions', (SELECT count(*) FROM "_m_permissions"),
                          'membersChanged', (SELECT count(*) FROM "_m_changed" c WHERE c."organization_id" = o."id"))
FROM "organizations" o;

-- Final safety check: every organisation that had an active Super Admin (or ADMIN) before still has one.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(o."slug", ', ') INTO bad FROM "organizations" o
  WHERE EXISTS (SELECT 1 FROM "_m_before" b WHERE b."organization_id" = o."id" AND b."old_status" = 'ACTIVE'
                AND array_replace(b."old_roles", 'ADMIN', 'SUPER_ADMIN') && ARRAY['SUPER_ADMIN'])
    AND "org_active_super_admins"(o."id") = 0;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration stopped: these organisations would lose their Super Admin: %', bad;
  END IF;
END;
$$;

COMMIT;
