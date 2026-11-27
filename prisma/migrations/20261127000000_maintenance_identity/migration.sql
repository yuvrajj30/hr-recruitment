-- Maintenance identity: the daily housekeeping functions belong to a separate database account (hr_maintenance) that
-- only the scheduled job has the password of. Until now they were gated by the session setting app.mode =
-- 'maintenance', which ANY connection can set for itself, and the web app's account (hr_runtime) could execute them:
-- removing candidates due for deletion, listing and confirming private-file removals, cleaning attendance device
-- details, generating rota shifts, writing leave balance lines and sending task reminders.
--
-- After this migration:
--   1. hr_runtime (and PUBLIC) can no longer EXECUTE the seven functions; hr_maintenance can, and nothing else beyond
--      what every account already has. It gets no table rights: the functions are SECURITY DEFINER and do the work.
--   2. Defence in depth: app_mode() reports 'maintenance' only to a session that logged in as hr_maintenance. Any other
--      account that sets app.mode = 'maintenance' gets 'refused', so the functions' own check fails too; and an
--      hr_maintenance session that sets any other mode (or none) also gets 'refused', so it can never act as staff,
--      as the public careers page or in the sign-in lookup. 'refused' matches no row-level security policy.
--
-- Needs the hr_maintenance account to exist first (prisma/sql/m4-01-create-maintenance-role.sql, run once per
-- PostgreSQL server by the admin account). The migration stops, changing nothing, if it does not.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_maintenance') THEN
    RAISE EXCEPTION 'The hr_maintenance account does not exist yet. Run prisma/sql/m4-01-create-maintenance-role.sql as the admin account first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_maintenance' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'The hr_maintenance account has powers it must not have (superuser, bypass RLS, create role/database or replication).';
  END IF;
  IF pg_has_role('hr_maintenance', 'hr_runtime', 'MEMBER') OR pg_has_role('hr_runtime', 'hr_maintenance', 'MEMBER')
     OR pg_has_role('hr_maintenance', 'hr_app', 'MEMBER') THEN
    RAISE EXCEPTION 'hr_maintenance must not be a member of hr_runtime or hr_app, nor hr_runtime a member of hr_maintenance.';
  END IF;
END
$$;

-- 1. Who may run the housekeeping functions.
REVOKE EXECUTE ON FUNCTION
  "app_remove_due_candidates"(INTEGER, UUID, TIMESTAMPTZ),
  "app_pending_file_removals"(INTEGER, UUID),
  "app_confirm_file_removed"(UUID[]),
  "app_remove_old_attendance_device_data"(INTEGER),
  "app_generate_standard_shifts"(INTEGER),
  "app_leave_housekeeping"(DATE),
  "app_task_housekeeping"(DATE)
FROM PUBLIC, hr_runtime;

GRANT USAGE ON SCHEMA public TO hr_maintenance;
GRANT EXECUTE ON FUNCTION
  "app_remove_due_candidates"(INTEGER, UUID, TIMESTAMPTZ),
  "app_pending_file_removals"(INTEGER, UUID),
  "app_confirm_file_removed"(UUID[]),
  "app_remove_old_attendance_device_data"(INTEGER),
  "app_generate_standard_shifts"(INTEGER),
  "app_leave_housekeeping"(DATE),
  "app_task_housekeeping"(DATE)
TO hr_maintenance;

-- 2. The mode follows the account that logged in, not only the setting. session_user is the login account of the
-- connection: it does not change inside SECURITY DEFINER functions or with SET ROLE, and only a superuser can change
-- it. Same signature, language and volatility as before; CREATE OR REPLACE keeps the owner and the grants.
CREATE OR REPLACE FUNCTION "app_mode"() RETURNS TEXT AS $$
  SELECT CASE
    WHEN session_user = 'hr_maintenance' THEN
      CASE WHEN "app_setting"('mode') = 'maintenance' THEN 'maintenance' ELSE 'refused' END
    WHEN "app_setting"('mode') = 'maintenance' THEN 'refused'
    ELSE "app_setting"('mode')
  END;
$$ LANGUAGE sql STABLE;

COMMIT;
