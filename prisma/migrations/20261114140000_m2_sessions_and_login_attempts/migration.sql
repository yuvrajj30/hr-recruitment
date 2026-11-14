-- Milestone 2, Change A: session timeouts and revocation, plus login-attempt tracking.
-- Everything below runs as ONE transaction. If any statement fails, nothing is kept.
BEGIN;

-- Safety guard: lock the sessions table, then stop if it already has rows
-- (the new required column cannot be added to a table that has rows).
LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sessions") THEN
    RAISE EXCEPTION 'sessions is not empty: migration stopped and nothing was changed';
  END IF;
END;
$$;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "revoked_at" TIMESTAMPTZ(6),
ADD COLUMN     "revoked_reason" TEXT;

-- Extra rule that Prisma's schema language cannot express (added by hand)
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_idle_not_after_absolute" CHECK ("expires_at" <= "absolute_expires_at");

-- CreateTable
CREATE TABLE "auth_login_attempts" (
    "id" UUID NOT NULL,
    "identifier_hash" TEXT NOT NULL,
    "ip_address" TEXT,
    "succeeded" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_login_attempts_identifier_hash_created_at_idx" ON "auth_login_attempts"("identifier_hash", "created_at");

-- CreateIndex
CREATE INDEX "auth_login_attempts_ip_address_created_at_idx" ON "auth_login_attempts"("ip_address", "created_at");

-- CreateIndex
CREATE INDEX "auth_login_attempts_created_at_idx" ON "auth_login_attempts"("created_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

COMMIT;
