import "server-only";
import type { AuditWriter } from "@/lib/auth/audit";
import { type AuthContext, requireOrganizationId, requirePermission } from "@/lib/auth/context";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { staffDb } from "@/lib/db-context";
import { conflict, invalid, notFound } from "@/lib/recruitment/errors";
import type { EmployeeInput, EmployeeStatus, EmploymentType, StructureInput } from "./rules";

// Employee Management: employee records and the organisation's structure (outlets, departments, designations).
//
// The same rules as the rest of the app:
//   - permission first (employee:read / employee:manage, or self:profile_read for one's own record), then the
//     organisation from the server-side session (never from the browser);
//   - every query goes through staffDb, so PostgreSQL row-level security checks who is asking as well;
//   - plain values out, and an audit row inside the same transaction as each change.
// The database adds its own rules (migration 20261121000000_employee_management): two-column keys so nothing
// points into another organisation, no reporting loops, records never deleted, and the assignment history written
// by the database itself whenever outlet, department, designation or manager changes.

export type EmployeeDeps = {
  db: Db;
  now: Date;
  writeAudit: AuditWriter;
  client: { ipAddress: string | null; userAgent: string | null };
};
type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

// Database refusals -> messages for people.
function friendly(error: unknown): Error {
  const msg = String((error as Error)?.message ?? "") + JSON.stringify((error as { meta?: unknown })?.meta ?? "");
  if (/manager_loop/.test(msg)) return invalid("That manager reports (directly or indirectly) to this employee. Choose someone else.", { managerId: "This would create a reporting loop." });
  if (/manager_not_active/.test(msg)) return invalid("Check the highlighted fields.", { managerId: "Choose an active employee." });
  if (/employee_exited/.test(msg)) return conflict("This employee has left. Their record can no longer be changed.");
  if (/employee_has_reports/.test(msg)) return invalid("Active employees still report to this person. Give them another manager first.");
  if (/employee_joined_after_attendance/.test(msg)) return invalid("This person has attendance or planned shifts before that joining date.", { joinedOn: "There is attendance before this date." });
  if (/employee_clocked_in/.test(msg)) return invalid("This person is clocked in. Close their attendance record first (Attendance → review).");
  if (/employee_attendance_after_exit/.test(msg)) return invalid("This person has attendance after that day. Choose a later last working day, or correct the attendance first.");
  if (/employees_organization_id_employee_code_key|employee_code/.test(msg) && /23505|duplicate|Unique constraint/i.test(msg)) {
    return invalid("Another employee already has this code.", { employeeCode: "This code is already used." });
  }
  if (/employees_member_id_key/.test(msg)) return conflict("That staff account is already linked to another employee.");
  if (/(outlets|designations|departments)_organization_id_name_key/.test(msg)) return invalid("That name is already used.", { name: "This name is already used." });
  if (/23503|Foreign key constraint/i.test(msg)) return invalid("One of the chosen items no longer exists. Reload and try again.");
  return error as Error;
}

// ---------------------------------------------------------------------------
// Structure: outlets, departments, designations
// ---------------------------------------------------------------------------

export type StructureKind = "outlet" | "department" | "designation";
export type StructureItem = { id: string; name: string; address: string | null; isActive: boolean; employees: number };
export type Structure = Record<StructureKind, StructureItem[]>;

// HR sees the whole structure. For anyone else row-level security returns only the outlets, departments and
// designations of their own (current or past) assignments.
export async function listStructure(rawDb: Db, ctx: AuthContext): Promise<Structure> {
  requireOrganizationId(ctx);
  const hr = ctx.permissions.has("employee:read");
  if (!hr) requirePermission(ctx, "self:profile_read");
  const db = staffDb(rawDb, ctx);
  const count = hr ? { select: { employees: { where: { status: "ACTIVE" as const } } } } : undefined;
  const [outlets, departments, designations] = await db.$transaction(async (tx) => [
    await tx.outlet.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], select: { id: true, name: true, address: true, isActive: true, ...(count ? { _count: count } : {}) } }),
    await tx.department.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], select: { id: true, name: true, isActive: true, ...(count ? { _count: count } : {}) } }),
    await tx.designation.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], select: { id: true, name: true, isActive: true, ...(count ? { _count: count } : {}) } }),
  ] as const);
  const item = (r: { id: string; name: string; address?: string | null; isActive: boolean; _count?: { employees: number } }): StructureItem =>
    ({ id: r.id, name: r.name, address: r.address ?? null, isActive: r.isActive, employees: r._count?.employees ?? 0 });
  return { outlet: outlets.map(item), department: departments.map(item), designation: designations.map(item) };
}

export async function createStructureItem(deps: EmployeeDeps, ctx: AuthContext, kind: StructureKind, input: StructureInput): Promise<{ id: string }> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  try {
    return await staffDb(deps.db, ctx).$transaction(async (tx) => {
      const data = { organizationId, name: input.name };
      const row =
        kind === "outlet" ? await tx.outlet.create({ data: { ...data, address: input.address }, select: { id: true } })
        : kind === "department" ? await tx.department.create({ data, select: { id: true } })
        : await tx.designation.create({ data, select: { id: true } });
      await audit(deps, tx, ctx, organizationId, `${kind}.created`, kind, row.id, { name: input.name });
      return row;
    });
  } catch (e) {
    throw friendly(e);
  }
}

export async function updateStructureItem(
  deps: EmployeeDeps, ctx: AuthContext, kind: StructureKind, id: string, change: { input?: StructureInput; isActive?: boolean },
): Promise<void> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!UUID.test(id)) throw notFound(`That ${kind}`);
  try {
    await staffDb(deps.db, ctx).$transaction(async (tx) => {
      const data: Record<string, unknown> = {};
      if (change.input) {
        data.name = change.input.name;
        if (kind === "outlet") data.address = change.input.address;
      }
      if (change.isActive !== undefined) data.isActive = change.isActive;
      const where = { id, organizationId };
      const r =
        kind === "outlet" ? await tx.outlet.updateMany({ where, data })
        : kind === "department" ? await tx.department.updateMany({ where, data })
        : await tx.designation.updateMany({ where, data });
      if (r.count !== 1) throw notFound(`That ${kind}`);
      await audit(deps, tx, ctx, organizationId, `${kind}.updated`, kind, id, { renamed: Boolean(change.input), isActive: change.isActive ?? null });
    });
  } catch (e) {
    throw friendly(e);
  }
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export type EmployeeListItem = {
  id: string; employeeCode: string; fullName: string; status: EmployeeStatus; employmentType: EmploymentType;
  outlet: string | null; department: string | null; designation: string | null; manager: string | null; hasAccount: boolean;
};
export type EmployeeFilter = { status?: EmployeeStatus | "ALL"; q?: string; outletId?: string };

export async function listEmployees(rawDb: Db, ctx: AuthContext, filter: EmployeeFilter = {}): Promise<EmployeeListItem[]> {
  requirePermission(ctx, "employee:read");
  const organizationId = requireOrganizationId(ctx);
  const q = filter.q?.trim().slice(0, 100);
  const where: Prisma.EmployeeWhereInput = {
    organizationId,
    ...(filter.status && filter.status !== "ALL" ? { status: filter.status } : filter.status === "ALL" ? {} : { status: "ACTIVE" }),
    ...(filter.outletId && UUID.test(filter.outletId) ? { outletId: filter.outletId } : {}),
    ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" } }, { employeeCode: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const rows = await staffDb(rawDb, ctx).employee.findMany({
    where,
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    take: 500,
    select: {
      id: true, employeeCode: true, fullName: true, status: true, employmentType: true, memberId: true,
      outlet: { select: { name: true } }, department: { select: { name: true } }, designation: { select: { name: true } }, manager: { select: { fullName: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id, employeeCode: r.employeeCode, fullName: r.fullName, status: r.status, employmentType: r.employmentType,
    outlet: r.outlet?.name ?? null, department: r.department?.name ?? null, designation: r.designation?.name ?? null,
    manager: r.manager?.fullName ?? null, hasAccount: r.memberId !== null,
  }));
}

export type EmployeeDetail = EmployeeListItem & {
  email: string | null; phone: string | null; joinedOn: string; exitedOn: string | null;
  outletId: string | null; departmentId: string | null; designationId: string | null; managerId: string | null; memberId: string | null;
  account: { name: string; email: string } | null;
  reports: { id: string; fullName: string; employeeCode: string }[];
  history: { startsAt: Date; endsAt: Date | null; outlet: string | null; department: string | null; designation: string | null; manager: string | null; changedBy: string | null }[];
};

async function readEmployee(db: Db, where: Prisma.EmployeeWhereInput, withChangedBy: boolean): Promise<EmployeeDetail | null> {
  const r = await db.employee.findFirst({
    where,
    select: {
      id: true, employeeCode: true, fullName: true, status: true, employmentType: true, email: true, phone: true, joinedOn: true, exitedOn: true,
      outletId: true, departmentId: true, designationId: true, managerId: true, memberId: true,
      outlet: { select: { name: true } }, department: { select: { name: true } }, designation: { select: { name: true } }, manager: { select: { fullName: true } },
      member: { select: { user: { select: { name: true, email: true } } } },
      reports: { where: { status: "ACTIVE" }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, employeeCode: true } },
      assignments: {
        orderBy: { startsAt: "desc" },
        take: 50,
        select: {
          startsAt: true, endsAt: true,
          outlet: { select: { name: true } }, department: { select: { name: true } }, designation: { select: { name: true } }, manager: { select: { fullName: true } },
          ...(withChangedBy ? { changedBy: { select: { name: true } } } : {}),
        },
      },
    },
  });
  if (!r) return null;
  return {
    id: r.id, employeeCode: r.employeeCode, fullName: r.fullName, status: r.status, employmentType: r.employmentType,
    email: r.email, phone: r.phone, joinedOn: dateOnly(r.joinedOn)!, exitedOn: dateOnly(r.exitedOn),
    outletId: r.outletId, departmentId: r.departmentId, designationId: r.designationId, managerId: r.managerId, memberId: r.memberId,
    outlet: r.outlet?.name ?? null, department: r.department?.name ?? null, designation: r.designation?.name ?? null, manager: r.manager?.fullName ?? null,
    hasAccount: r.memberId !== null,
    account: r.member ? { name: r.member.user.name, email: r.member.user.email } : null,
    reports: r.reports,
    history: r.assignments.map((a) => ({
      startsAt: a.startsAt, endsAt: a.endsAt, outlet: a.outlet?.name ?? null, department: a.department?.name ?? null,
      designation: a.designation?.name ?? null, manager: a.manager?.fullName ?? null,
      changedBy: (a as { changedBy?: { name: string } | null }).changedBy?.name ?? null,
    })),
  };
}

export async function getEmployee(rawDb: Db, ctx: AuthContext, id: string): Promise<EmployeeDetail> {
  requirePermission(ctx, "employee:read");
  const organizationId = requireOrganizationId(ctx);
  if (!UUID.test(id)) throw notFound("That employee");
  const e = await readEmployee(staffDb(rawDb, ctx), { id, organizationId }, true);
  if (!e) throw notFound("That employee");
  return e;
}

// The signed-in person's own employee record (only if HR has linked it to their account). Row-level security
// shows nothing else to an employee.
export async function getMyEmployee(rawDb: Db, ctx: AuthContext): Promise<EmployeeDetail | null> {
  requirePermission(ctx, "self:profile_read");
  const organizationId = requireOrganizationId(ctx);
  if (!ctx.memberId) return null;
  const db = staffDb(rawDb, ctx);
  const e = await readEmployee(db, { organizationId, memberId: ctx.memberId }, false);
  if (!e) return null;
  // Colleagues are not listed to an employee; and the manager's name comes from their own row, which row-level
  // security only shows to HR, so it may be missing here.
  return { ...e, reports: [], account: null };
}

const employeeData = (input: EmployeeInput) => ({
  employeeCode: input.employeeCode, fullName: input.fullName, email: input.email, phone: input.phone,
  employmentType: input.employmentType, joinedOn: asDate(input.joinedOn),
  outletId: input.outletId, departmentId: input.departmentId, designationId: input.designationId, managerId: input.managerId,
});

// Outlet, department and designation must be active ones of this organisation; the manager an active employee.
async function checkReferences(tx: Tx, organizationId: string, input: EmployeeInput, selfId: string | null): Promise<void> {
  const errors: Record<string, string> = {};
  const active = async (kind: "outlet" | "department" | "designation", id: string | null, current: string | null) => {
    if (!id || id === current) return;
    const where = { id, organizationId, isActive: true };
    const n = kind === "outlet" ? await tx.outlet.count({ where }) : kind === "department" ? await tx.department.count({ where }) : await tx.designation.count({ where });
    if (n !== 1) errors[`${kind}Id`] = "Choose an active one from the list.";
  };
  const current = selfId ? await tx.employee.findFirst({ where: { id: selfId, organizationId }, select: { outletId: true, departmentId: true, designationId: true, managerId: true } }) : null;
  await active("outlet", input.outletId, current?.outletId ?? null);
  await active("department", input.departmentId, current?.departmentId ?? null);
  await active("designation", input.designationId, current?.designationId ?? null);
  if (input.managerId && input.managerId !== current?.managerId) {
    if (input.managerId === selfId) errors.managerId = "An employee cannot be their own manager.";
    else if ((await tx.employee.count({ where: { id: input.managerId, organizationId, status: "ACTIVE" } })) !== 1) errors.managerId = "Choose an active employee.";
  }
  if (Object.keys(errors).length) throw invalid("Check the highlighted fields.", errors);
}

export async function createEmployee(deps: EmployeeDeps, ctx: AuthContext, input: EmployeeInput): Promise<{ id: string }> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  try {
    return await staffDb(deps.db, ctx).$transaction(async (tx) => {
      await checkReferences(tx, organizationId, input, null);
      const row = await tx.employee.create({ data: { organizationId, ...employeeData(input) }, select: { id: true } });
      await audit(deps, tx, ctx, organizationId, "employee.created", "employee", row.id, { employeeCode: input.employeeCode });
      return row;
    });
  } catch (e) {
    throw friendly(e);
  }
}

export async function updateEmployee(deps: EmployeeDeps, ctx: AuthContext, id: string, input: EmployeeInput): Promise<void> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!UUID.test(id)) throw notFound("That employee");
  try {
    await staffDb(deps.db, ctx).$transaction(async (tx) => {
      const before = await tx.employee.findFirst({ where: { id, organizationId }, select: { status: true } });
      if (!before) throw notFound("That employee");
      if (before.status === "EXITED") throw conflict("This employee has left. Their record can no longer be changed.");
      await checkReferences(tx, organizationId, input, id);
      await tx.employee.update({ where: { id }, data: employeeData(input) });
      // No personal details in the audit log: only which fields were sent.
      await audit(deps, tx, ctx, organizationId, "employee.updated", "employee", id, { employeeCode: input.employeeCode });
    });
  } catch (e) {
    throw friendly(e);
  }
}

export async function markEmployeeExited(deps: EmployeeDeps, ctx: AuthContext, id: string, exitedOn: string): Promise<void> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!UUID.test(id)) throw notFound("That employee");
  try {
    await staffDb(deps.db, ctx).$transaction(async (tx) => {
      const e = await tx.employee.findFirst({ where: { id, organizationId }, select: { status: true, _count: { select: { reports: { where: { status: "ACTIVE" } } } } } });
      if (!e) throw notFound("That employee");
      if (e.status === "EXITED") throw conflict("This employee is already marked as left.");
      if (e._count.reports > 0) throw invalid(`${e._count.reports} active employee(s) report to this person. Give them another manager first.`);
      await tx.employee.update({ where: { id }, data: { status: "EXITED", exitedOn: asDate(exitedOn) } });
      await audit(deps, tx, ctx, organizationId, "employee.exited", "employee", id, { exitedOn });
    });
  } catch (e) {
    throw friendly(e);
  }
}

// Link (or unlink with null) the employee record to a staff account of this organisation, so that person can see
// their own record.
export async function linkEmployeeAccount(deps: EmployeeDeps, ctx: AuthContext, id: string, memberId: string | null): Promise<void> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  if (!UUID.test(id) || (memberId !== null && !UUID.test(memberId))) throw notFound("That employee");
  try {
    await staffDb(deps.db, ctx).$transaction(async (tx) => {
      if (memberId && (await tx.organizationMember.count({ where: { id: memberId, organizationId, status: "ACTIVE" } })) !== 1) {
        throw invalid("Choose an active staff account from the list.", { memberId: "Choose an active staff account." });
      }
      const r = await tx.employee.updateMany({ where: { id, organizationId }, data: { memberId } });
      if (r.count !== 1) throw notFound("That employee");
      await audit(deps, tx, ctx, organizationId, memberId ? "employee.account_linked" : "employee.account_unlinked", "employee", id, {});
    });
  } catch (e) {
    throw friendly(e);
  }
}

// Staff accounts that can still be linked (active, not linked to another record), for the link form.
export async function listLinkableAccounts(rawDb: Db, ctx: AuthContext): Promise<{ memberId: string; name: string; email: string }[]> {
  requirePermission(ctx, "employee:manage");
  const organizationId = requireOrganizationId(ctx);
  const rows = await staffDb(rawDb, ctx).organizationMember.findMany({
    where: { organizationId, status: "ACTIVE", employees: { none: {} } },
    orderBy: { user: { name: "asc" } },
    select: { id: true, user: { select: { name: true, email: true } } },
  });
  return rows.map((r) => ({ memberId: r.id, name: r.user.name, email: r.user.email }));
}

// Active employees for the manager picker (optionally leaving one out).
export async function listManagerChoices(rawDb: Db, ctx: AuthContext, exceptId?: string): Promise<{ id: string; fullName: string; employeeCode: string }[]> {
  requirePermission(ctx, "employee:read");
  const organizationId = requireOrganizationId(ctx);
  return staffDb(rawDb, ctx).employee.findMany({
    where: { organizationId, status: "ACTIVE", ...(exceptId && UUID.test(exceptId) ? { id: { not: exceptId } } : {}) },
    orderBy: { fullName: "asc" },
    take: 1000,
    select: { id: true, fullName: true, employeeCode: true },
  });
}

async function audit(deps: EmployeeDeps, tx: Tx, ctx: AuthContext, organizationId: string, action: string, entityType: string, entityId: string, metadata: Record<string, string | number | boolean | null>) {
  await deps.writeAudit(tx, { organizationId, actorUserId: ctx.user.id, action, entityType, entityId, metadata, ...deps.client, now: deps.now });
}
