// Tasks through the service layer (src/lib/tasks/tasks.ts, src/lib/notifications/notifications.ts,
// src/lib/tasks/housekeeping.ts), against the DISPOSABLE test database and a temporary file store. The database rules are
// covered in tasks.test.ts; this checks what the screens rely on: permission keys first, files stored and cleaned up,
// evidence readable only by those who may see the task (and audited), notifications, and friendly refusals.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { listMyNotifications, markAllRead, markRead, unreadCount } from "@/lib/notifications/notifications";
import type { AppDeps } from "@/lib/recruitment/applications";
import { createLocalStorage } from "@/lib/recruitment/storage";
import { runTaskHousekeeping } from "@/lib/tasks/housekeeping";
import {
  addTaskResource, assignTask, cancelTask, editTask, getTask, listApprovedTasksForEmployee, listMyTasks, listTasks, readEvidence, readResource,
  removeTaskResource, reviewTask, startTask, submitTask,
} from "@/lib/tasks/tasks";
import { realRoleIds } from "./roles-helper";
import { giveSession, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const maintenanceUrl = process.env.TEST_MAINTENANCE_URL; // the scheduled job's own account
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl) && isTestDb(maintenanceUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
type Who = "sa" | "hr" | "emp" | "emp2" | "hrB";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const jpeg = () => ({ name: "store.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(200)]) });
const pdf = () => ({ name: "checklist.pdf", bytes: new Uint8Array([...ascii("%PDF-1.7\n"), ...randomBytes(200)]) });
const gif = () => ({ name: "funny.gif", bytes: new Uint8Array([...ascii("GIF89a"), ...randomBytes(50)]) });
const upload = (f: { name: string; bytes: Uint8Array }) => ({ name: f.name, size: f.bytes.length, bytes: f.bytes });

describe.skipIf(!enabled)("tasks service (test database)", { timeout: 90_000 }, () => {
  let owner: Db;
  let db: Db;
  let mdb: Db;
  let raw: Client;
  const orgs: string[] = [];
  const userIds: string[] = [];
  const ctx = {} as Record<Who, AuthContext>;
  const emp = {} as Record<"sa" | "hr" | "emp" | "emp2" | "nologin", string>;
  let outlet = "";
  let outlet2 = "";
  let today = "";
  let storeDir = "";
  const audits: AuditEntry[] = [];
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const deps = (): AppDeps => ({ db, now: new Date(), storage: createLocalStorage(storeDir), client: { ipAddress: null, userAgent: null },
    writeAudit: async (_tx, entry) => { audits.push(entry); } });
  const filesInStore = (): string[] => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
    return walk(storeDir).filter((f) => f.includes(`${path.sep}tasks${path.sep}`));
  };
  const input = (owner: "emp" | "emp2" | "nologin" | "hr", extra: Partial<{ proof: ("PHOTO" | "DOCUMENT" | "TEXT")[]; dueOn: string }> = {}) => ({
    ownerId: emp[owner], outletId: outlet2, title: "Clean the espresso machine", description: "Descale it and photograph the result.",
    dueOn: extra.dueOn ?? day(2), dueTime: null, priority: "HIGH" as const, proof: extra.proof ?? (["PHOTO", "TEXT"] as ("PHOTO" | "DOCUMENT" | "TEXT")[]),
  });

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 3 });
    mdb = createDb(maintenanceUrl!, { max: 1 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    storeDir = mkdtempSync(path.join(tmpdir(), "cafeos-task-store-"));
    today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d;
    const role = await realRoleIds(owner);
    const keyOf: Record<Who, RoleKey> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", emp2: "EMPLOYEE", hrB: "HR_MANAGER" };
    const users = {} as Record<Who, { id: string; email: string; name: string }>;
    for (const who of Object.keys(keyOf) as Who[]) {
      users[who] = await owner.user.create({ data: { email: `${who}-${rnd()}@tasksvc.example.test`, name: `${who} person` } });
      userIds.push(users[who].id);
    }
    const a = await owner.organization.create({ data: { slug: `tasksvc-a-${rnd()}${rnd()}`, name: "Tasks service A", ownerUserId: users.sa.id, timezone: TZ } });
    const b = await owner.organization.create({ data: { slug: `tasksvc-b-${rnd()}${rnd()}`, name: "Tasks service B", ownerUserId: users.hrB.id, timezone: TZ } });
    orgs.push(a.id, b.id);
    outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Main', now()) RETURNING id`, [a.id])).rows[0].id;
    outlet2 = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Second', now()) RETURNING id`, [a.id])).rows[0].id;
    for (const who of Object.keys(keyOf) as Who[]) {
      const o = who === "hrB" ? b : a;
      const m = await owner.organizationMember.create({ data: { organizationId: o.id, userId: users[who].id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } });
      ctx[who] = await giveSession(owner, {
        sessionId: "00000000-0000-0000-0000-000000000000", user: { ...users[who], isPlatformAdmin: false },
        organization: { id: o.id, name: o.name, slug: o.slug }, memberId: m.id, expiresAt: new Date(), absoluteExpiresAt: new Date(),
        roleKeys: [keyOf[who]], permissions: new Set(ROLE_PERMISSIONS[keyOf[who]]),
      });
      if (who !== "hrB") {
        emp[who] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
          VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [a.id, `TS-${who}-${rnd()}`.toUpperCase(), `${who} person`, outlet, m.id])).rows[0].id;
      }
    }
    emp.nologin = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, updated_at)
      VALUES ($1, $2, 'No login', '2026-01-01', $3, now()) RETURNING id`, [a.id, `TS-NL-${rnd()}`.toUpperCase(), outlet])).rows[0].id;
  }, 90_000);

  afterAll(async () => {
    if (raw && orgs.length) {
      for (const t of ["notifications", "task_reminders", "task_evidence", "task_resources", "task_submissions", "task_events", "tasks"]) {
        await raw.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [orgs]).catch(() => undefined);
      }
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgs]);
      await raw.query(`DELETE FROM leave_types WHERE organization_id = ANY($1)`, [orgs]).catch(() => undefined);
      await raw.query(`DELETE FROM outlets WHERE organization_id = ANY($1)`, [orgs]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgs } } });
      await purgeTestAuditRows(owner, orgs);
      await owner.organization.deleteMany({ where: { id: { in: orgs } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    await owner?.$disconnect();
    await db?.$disconnect();
    await mdb?.$disconnect();
    await raw?.end();
  });

  it("checks permission keys before asking the database, and explains refusals in plain words", async () => {
    await expect(listTasks(db, ctx.emp, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignTask(deps(), ctx.emp, input("emp2"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listApprovedTasksForEmployee(db, ctx.emp, emp.emp2)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignTask(deps(), ctx.hr, input("nologin"))).rejects.toMatchObject({ message: /no active account/ });
    const id = await assignTask(deps(), ctx.hr, input("emp"));
    await expect(startTask(deps(), ctx.hr, id)).rejects.toMatchObject({ message: /Only the person the task is assigned to/ });
    await expect(getTask(db, ctx.hrB, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getTask(db, ctx.emp2, id)).rejects.toMatchObject({ code: "not_found" });
    expect((await listMyTasks(db, ctx.emp)).map((t) => t.id)).toContain(id);
    expect((await listMyTasks(db, ctx.emp2)).map((t) => t.id)).not.toContain(id);
    await cancelTask(deps(), ctx.hr, id, "Test cleanup");
  });

  it("stores evidence under tasks/, lists it on the task, and lets the owner download it with an audit record", async () => {
    const id = await assignTask(deps(), ctx.hr, input("emp", { proof: ["PHOTO", "DOCUMENT", "TEXT"] }));
    await startTask(deps(), ctx.emp, id);
    const before = filesInStore().length;
    await submitTask(deps(), ctx.emp, id, "Done, photo and checklist attached", [upload(jpeg()), upload(pdf())]);
    expect(filesInStore().length).toBe(before + 2);
    const detail = await getTask(db, ctx.emp, id);
    expect(detail).toMatchObject({ status: "SUBMITTED", canWork: false, canReview: false });
    expect(detail.submissions).toHaveLength(1);
    expect(detail.submissions[0]!.evidence.map((e) => e.mimeType).sort()).toEqual(["application/pdf", "image/jpeg"]);
    const evId = detail.submissions[0]!.evidence[0]!.id;
    audits.length = 0;
    const file = await readEvidence(deps(), ctx.emp, evId);
    expect(file.bytes.length).toBeGreaterThan(0);
    expect(audits.map((a) => a.action)).toEqual(["task.evidence_downloaded"]);
    // Review Focus 2: another employee and another organisation's HR cannot read it.
    await expect(readEvidence(deps(), ctx.emp2, evId)).rejects.toMatchObject({ code: "not_found" });
    await expect(readEvidence(deps(), ctx.hrB, evId)).rejects.toMatchObject({ code: "not_found" });
    expect((await getTask(db, ctx.hr, id)).canReview).toBe(true);
    await reviewTask(deps(), ctx.hr, id, true, 4, "Well done");
    expect(await getTask(db, ctx.emp, id)).toMatchObject({ status: "APPROVED", rating: 4, ratingComment: "Well done" });
    expect((await listApprovedTasksForEmployee(db, ctx.hr, emp.emp)).find((t) => t.id === id)).toMatchObject({ rating: 4 });
  });

  it("leaves no file behind when a submission is refused (Review Focus 1)", async () => {
    const id = await assignTask(deps(), ctx.hr, input("emp2"));
    await startTask(deps(), ctx.emp2, id);
    const before = filesInStore().length;
    // One good photo and one GIF: refused before anything is kept.
    await expect(submitTask(deps(), ctx.emp2, id, "x", [upload(jpeg()), upload(gif())])).rejects.toMatchObject({ code: "invalid" });
    expect(filesInStore().length).toBe(before);
    // The database refuses (the task needs text too): the stored photo is removed again.
    await expect(submitTask(deps(), ctx.emp2, id, null, [upload(jpeg())])).rejects.toMatchObject({ message: /every kind of proof/ });
    expect(filesInStore().length).toBe(before);
    await cancelTask(deps(), ctx.hr, id, "Test cleanup");
  });

  it("hides evidence and resources from the previous owner once a task is moved (Review Focus 2)", async () => {
    const id = await assignTask(deps(), ctx.hr, input("emp", { proof: ["TEXT"] }));
    const resId = await addTaskResource(deps(), ctx.hr, id, { file: upload(pdf()) });
    const linkId = await addTaskResource(deps(), ctx.hr, id, { url: "https://example.com/how-to-descale" });
    expect((await readResource(deps(), ctx.emp, resId)).name).toMatch(/\.pdf$/);
    expect((await getTask(db, ctx.emp, id)).resources.map((r) => r.id).sort()).toEqual([resId, linkId].sort());
    await removeTaskResource(deps(), ctx.hr, linkId);
    expect((await getTask(db, ctx.emp, id)).resources.map((r) => r.id)).toEqual([resId]);
    const t = await getTask(db, ctx.hr, id);
    await editTask(deps(), ctx.hr, id, { ...input("emp2", { proof: ["TEXT"] }), dueOn: t.dueOn }, "Emp is on leave");
    await expect(readResource(deps(), ctx.emp, resId)).rejects.toMatchObject({ code: "not_found" });
    // HR's reason for moving or editing a task stays with HR: the new owner sees that it happened, not why.
    const seenByNewOwner = (await getTask(db, ctx.emp2, id)).events.filter((e) => e.kind === "REASSIGNED");
    expect(seenByNewOwner).toHaveLength(1);
    expect(seenByNewOwner[0]!.note).toBeNull();
    expect(JSON.stringify(seenByNewOwner)).not.toMatch(/Emp is on leave/);
    expect((await getTask(db, ctx.hr, id)).events.find((e) => e.kind === "REASSIGNED")!.note).toBe("Emp is on leave");
    await expect(getTask(db, ctx.emp, id)).rejects.toMatchObject({ code: "not_found" });
    expect((await getTask(db, ctx.emp2, id)).status).toBe("ASSIGNED");
    await cancelTask(deps(), ctx.hr, id, "Test cleanup");
  });

  it("notifies the owner, counts unread and marks only their own notifications as read", async () => {
    const id = await assignTask(deps(), ctx.hr, input("emp2", { proof: ["TEXT"] }));
    const mine = await listMyNotifications(db, ctx.emp2);
    const n = mine.find((x) => x.taskId === id)!;
    expect(n).toMatchObject({ type: "TASK_ASSIGNED", read: false });
    const unread = await unreadCount(db, ctx.emp2);
    expect(unread).toBeGreaterThan(0);
    await expect(markRead(db, ctx.emp, n.id)).rejects.toMatchObject({ code: "not_found" });
    await markRead(db, ctx.emp2, n.id);
    expect(await unreadCount(db, ctx.emp2)).toBe(unread - 1);
    await markAllRead(db, ctx.emp2);
    expect(await unreadCount(db, ctx.emp2)).toBe(0);
    await cancelTask(deps(), ctx.hr, id, "Test cleanup");
  });

  it("runs the daily reminders through the maintenance account and deletes nothing", async () => {
    const id = await assignTask(deps(), ctx.hr, input("emp", { proof: ["TEXT"], dueOn: today }));
    const before = filesInStore().length;
    await expect(runTaskHousekeeping(db)).rejects.toThrow(/permission denied for function app_task_housekeeping/); // not the web app's account
    const r = await runTaskHousekeeping(mdb);
    expect(r).not.toBeNull();
    expect(typeof r!.reminders).toBe("number");
    expect(filesInStore().length).toBe(before);
    expect((await listMyNotifications(db, ctx.emp)).some((x) => x.taskId === id && x.type === "TASK_DUE")).toBe(true);
    await cancelTask(deps(), ctx.hr, id, "Test cleanup");
  });
});
