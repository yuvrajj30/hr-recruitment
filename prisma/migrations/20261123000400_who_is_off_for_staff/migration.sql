-- Leave: "who is off" for every member (owner decision, 22 Nov 2026).
-- Staff may see who is off and when, so the cafe can plan around it. They see approved leave only, with the person's
-- name, the days and any half days. Never the leave type (it can reveal sick leave), the note, the balance or requests
-- still waiting. HR keeps its fuller view through row-level security on leave_requests (leave:read).
BEGIN;

CREATE FUNCTION "app_who_is_off"(p_from DATE, p_to DATE)
RETURNS TABLE ("employee_id" UUID, "employee_name" TEXT, "start_day" DATE, "end_day" DATE, "start_half" BOOLEAN, "end_half" BOOLEAN) AS $$
DECLARE
  v_org UUID := "app_org_id"();
BEGIN
  IF v_org IS NULL OR "app_staff_role"() IS NULL THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to > p_from + 62 THEN
    RAISE EXCEPTION 'leave_bad_period' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT q."employee_id", e."full_name", q."start_day", q."end_day", q."start_half", q."end_half"
    FROM "leave_requests" q
    JOIN "employees" e ON e."id" = q."employee_id" AND e."organization_id" = q."organization_id"
    WHERE q."organization_id" = v_org AND q."status" = 'APPROVED' AND q."start_day" <= p_to AND q."end_day" >= p_from
    ORDER BY q."start_day", e."full_name", q."employee_id";
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

REVOKE ALL ON FUNCTION "app_who_is_off"(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_who_is_off"(DATE, DATE) TO hr_runtime;

COMMIT;
