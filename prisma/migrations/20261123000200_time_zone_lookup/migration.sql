-- Fast organisation time zone check.
-- att_org_timezone checked the zone against the pg_timezone_names view on every call. That view reads the whole time
-- zone database (about 200 ms a call), and the check runs for every shift the rota fill touches and every clock-in,
-- so the daily rota run could pass the 30 s statement limit. The valid names are now kept in a table filled from
-- pg_timezone_names. A name missing from it still falls back to the old check, so a zone added by a PostgreSQL update
-- keeps working and exactly the same names are accepted as before.

CREATE TABLE "time_zone_names" (
  "name" TEXT NOT NULL,
  CONSTRAINT "time_zone_names_pkey" PRIMARY KEY ("name")
);
INSERT INTO "time_zone_names" ("name") SELECT DISTINCT "name" FROM pg_timezone_names;

-- Not company data, but nobody except the database functions needs it.
ALTER TABLE "time_zone_names" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "time_zone_names" FROM PUBLIC;
REVOKE ALL ON "time_zone_names" FROM hr_runtime;

CREATE OR REPLACE FUNCTION "att_org_timezone"(p_org UUID) RETURNS TEXT AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT o."timezone" INTO v_tz FROM "organizations" o WHERE o."id" = p_org;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'invalid_timezone' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "time_zone_names" z WHERE z."name" = v_tz) THEN
    -- Slow path, only for names not in the table (a typo, or a zone newer than the table).
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE "name" = v_tz) THEN
      RAISE EXCEPTION 'invalid_timezone' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN v_tz;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
