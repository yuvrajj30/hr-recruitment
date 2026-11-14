-- ============================================================================
-- CHANGE B, PART 1 of 2: create the restricted account the running app will use.
-- Run ONCE for the whole PostgreSQL server, connected as the admin account (postgres).
-- The password is NOT in this file: you set it afterwards with \password so it is
-- typed hidden and never written anywhere.
-- ============================================================================

-- Create the account. It can log in but has none of the powerful abilities.
CREATE ROLE hr_runtime
  LOGIN
  NOSUPERUSER      -- not an administrator
  NOCREATEDB       -- cannot create databases
  NOCREATEROLE     -- cannot create other accounts
  NOREPLICATION    -- cannot copy the whole database out
  NOBYPASSRLS      -- will still obey row-level security when we add it later
  NOINHERIT        -- does not quietly pick up other accounts' powers
  CONNECTION LIMIT 20;

-- Safety nets: a runaway query or a forgotten open transaction is stopped automatically.
ALTER ROLE hr_runtime SET statement_timeout = '30s';
ALTER ROLE hr_runtime SET idle_in_transaction_session_timeout = '30s';

-- Allow it to connect to the HR database (and nothing else is granted yet).
GRANT CONNECT ON DATABASE hr_recruitment TO hr_runtime;
