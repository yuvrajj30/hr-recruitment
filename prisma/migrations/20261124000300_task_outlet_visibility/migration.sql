-- Tasks: the owner of a task may read the name of the task's outlet. Employees otherwise see only the outlets of their
-- own assignment history (20261121010000_employee_management_fixes), and a task can be at another outlet (the task's
-- outlet is independent of the home outlet), so without this the employee could not see where the work happens.
-- Read-only, own current tasks only; no other outlet becomes visible.
BEGIN;

CREATE POLICY "own_task_outlet" ON "outlets" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"())
  AND (SELECT "app_has_permission"('self:task'))
  AND "id" IN (SELECT t."outlet_id" FROM "tasks" t WHERE t."owner_employee_id" = (SELECT "app_my_employee_id"())));

COMMIT;
