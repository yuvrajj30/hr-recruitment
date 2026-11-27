-- ============================================================================
-- Create the account ONLY the scheduled housekeeping job uses (hr_maintenance).
-- Run ONCE for the whole PostgreSQL server, connected as the admin account (postgres).
-- The password is NOT in this file: set it afterwards with \password so it is typed
-- hidden and never written anywhere except the job's own settings file.
--
-- Why a separate account: the daily job removes candidates due for deletion, deletes
-- their private files, cleans attendance device details, fills the rota and writes
-- leave balances. Those database functions must not be callable by the web app's
-- account (hr_runtime), whatever session settings it sets. The migration
-- 20261127000000_maintenance_identity grants them to hr_maintenance only.
--
-- What it can do: log in, and run those housekeeping functions. Nothing else:
-- no table can be read or changed directly, it is not a superuser, cannot create
-- databases or accounts, and does not bypass row-level security.
-- ============================================================================

CREATE ROLE hr_maintenance
  LOGIN
  NOSUPERUSER      -- not an administrator
  NOCREATEDB       -- cannot create databases
  NOCREATEROLE     -- cannot create other accounts
  NOREPLICATION    -- cannot copy the whole database out
  NOBYPASSRLS      -- obeys row-level security
  NOINHERIT        -- does not quietly pick up other accounts' powers
  CONNECTION LIMIT 10;  -- the daily job uses 2; the test suite runs several files at once

-- Safety nets. The retention job raises the statement limit for its own batches.
ALTER ROLE hr_maintenance SET statement_timeout = '60s';
ALTER ROLE hr_maintenance SET idle_in_transaction_session_timeout = '60s';

-- Allow it to connect to a database. For now only the disposable test database is named;
-- the real database gets this line at its own release, with the owner's approval:
--   GRANT CONNECT ON DATABASE hr_recruitment TO hr_maintenance;
-- (Note: PostgreSQL lets every account CONNECT to a database by default, and these databases
-- keep that default, so the account could already connect to hr_recruitment. It can do
-- nothing there: it has no table rights, and the housekeeping functions are granted to it
-- only by the maintenance_identity migration, once that is applied to that database.)
GRANT CONNECT ON DATABASE hr_recruitment_test TO hr_maintenance;

-- Then set its password (typed hidden):
--   \password hr_maintenance
