-- Accepting an invitation.
--
-- The person accepting is not signed in yet, so no staff identity exists for row-level security to check.
-- Instead of opening up the protected tables, two narrow functions do exactly this one job. Both take only
-- the SHA-256 fingerprint of the invitation link (the link itself is never stored anywhere):
--
--   app_invitation_lookup   - what the invitation page needs to show. Returns nothing for a link that
--                             does not exist, was revoked, was already used, has expired, or whose
--                             organisation is not active (all look the same from outside).
--   app_accept_invitation   - in ONE locked step: re-checks the invitation, creates the account (or uses
--                             the existing one), adds the membership with the invited role, and marks the
--                             invitation as used. A link can never be used twice, even by two clicks at once.
--
-- Passwords are checked and hashed by the application before calling these; only the bcrypt hash reaches
-- the database. An EXISTING account is joined only after the application has verified that account's own
-- password; the function refuses to change an existing account's password.
BEGIN;

CREATE FUNCTION "app_invitation_lookup"(p_token_hash TEXT)
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
    AND o."status" = 'ACTIVE';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE FUNCTION "app_accept_invitation"(p_token_hash TEXT, p_name TEXT, p_new_password_hash TEXT)
RETURNS TABLE ("user_id" UUID, "organization_id" UUID, "member_id" UUID, "role_key" TEXT, "new_account" BOOLEAN) AS $$
DECLARE
  inv RECORD;
  v_user RECORD;
  v_user_id UUID;
  v_member_id UUID;
  v_new BOOLEAN := false;
BEGIN
  -- Lock the invitation row: a second, simultaneous acceptance waits here and then finds it used.
  SELECT i.* INTO inv FROM "staff_invitations" i
  JOIN "organizations" o ON o."id" = i."organization_id"
  WHERE i."token_hash" = p_token_hash AND o."status" = 'ACTIVE'
  FOR UPDATE OF i;
  IF NOT FOUND OR inv."accepted_at" IS NOT NULL OR inv."revoked_at" IS NOT NULL OR inv."expires_at" <= now() THEN
    RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT u."id", u."status" INTO v_user FROM "users" u WHERE u."email" = inv."email";
  IF FOUND THEN
    -- An existing account: the application has verified its password; it is never changed here.
    IF p_new_password_hash IS NOT NULL THEN
      RAISE EXCEPTION 'account_exists' USING ERRCODE = 'P0001';
    END IF;
    IF v_user."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'account_disabled' USING ERRCODE = 'P0001';
    END IF;
    v_user_id := v_user."id";
  ELSE
    IF p_new_password_hash IS NULL OR p_new_password_hash !~ '^\$2[aby]\$\d{2}\$.{53}$' THEN
      RAISE EXCEPTION 'password_required' USING ERRCODE = 'P0001';
    END IF;
    IF p_name IS NULL OR length(btrim(p_name)) < 2 OR length(p_name) > 120 THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO "users" ("id", "email", "name", "password_hash", "status", "updated_at")
    VALUES (gen_random_uuid(), inv."email", btrim(p_name), p_new_password_hash, 'ACTIVE', now())
    RETURNING "users"."id" INTO v_user_id;
    v_new := true;
  END IF;

  IF EXISTS (SELECT 1 FROM "organization_members" om WHERE om."organization_id" = inv."organization_id" AND om."user_id" = v_user_id) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "organization_members" ("id", "organization_id", "user_id", "status", "invited_by_id", "joined_at", "updated_at")
  VALUES (gen_random_uuid(), inv."organization_id", v_user_id, 'ACTIVE', inv."invited_by_id", now(), now())
  RETURNING "organization_members"."id" INTO v_member_id;

  INSERT INTO "organization_member_roles" ("member_id", "role_id")
  SELECT v_member_id, r."id" FROM "roles" r WHERE r."key" = inv."role_key";

  UPDATE "staff_invitations" SET "accepted_at" = now(), "accepted_user_id" = v_user_id WHERE "id" = inv."id";

  RETURN QUERY SELECT v_user_id, inv."organization_id", v_member_id, inv."role_key", v_new;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;

-- Only the application's own account may call them.
REVOKE ALL ON FUNCTION "app_invitation_lookup"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_accept_invitation"(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_invitation_lookup"(TEXT) TO hr_runtime;
GRANT EXECUTE ON FUNCTION "app_accept_invitation"(TEXT, TEXT, TEXT) TO hr_runtime;

COMMIT;
