-- ============================================================================
-- CHANGE B, PART 2 of 2: say exactly what hr_runtime may do inside the database.
-- Run as the OWNER account (hr_app), connected to hr_recruitment.
-- Safe to run again: granting something that is already granted changes nothing.
-- ============================================================================

-- Let it see the tables' schema ("public"). It gets no right to create anything there.
GRANT USAGE ON SCHEMA public TO hr_runtime;

-- Normal work: read, add, change and remove rows in every table.
-- (It still cannot TRUNCATE, ALTER, DROP, add triggers or change ownership:
--  those rights are never granted, and only the table owner has them.)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hr_runtime;

-- Prisma's own migration bookkeeping table is off limits to the running app.
REVOKE ALL ON TABLE "_prisma_migrations" FROM hr_runtime;

-- Append-only records: the app may read and add, but never change or delete.
-- (Database triggers already block this too; permissions are a second, independent lock.)
REVOKE UPDATE, DELETE ON TABLE "audit_logs"                 FROM hr_runtime;
REVOKE UPDATE, DELETE ON TABLE "integration_sync_errors"    FROM hr_runtime;
REVOKE UPDATE, DELETE ON TABLE "application_status_history" FROM hr_runtime;

-- Tables created by FUTURE migrations (run by hr_app) automatically get the normal
-- read/write rights. Any future append-only table needs its own REVOKE line like the above.
ALTER DEFAULT PRIVILEGES FOR ROLE hr_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hr_runtime;
