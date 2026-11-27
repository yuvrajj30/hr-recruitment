// ============================================================================
// Seed script: creates the minimum data needed to log in for the first time.
//   1. Permissions (the list of things a person can be allowed to do)
//   2. The three roles (Super Admin, HR Manager, Employee), each linked to its permissions
//   3. The first company (organization), its owner and its first Super Admin
//
// Safe to run more than once: anything that already exists is left alone.
// The admin password is typed when the script runs. It is never saved in any
// file, and only a bcrypt hash of it goes into the database.
// ============================================================================
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { ROLE_DESCRIPTIONS, ROLE_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from "../src/lib/auth/roles";

// ---- The first company and admin (change these here if ever needed) --------
const ORGANIZATION = {
  name: "The Trust Coffee",
  slug: "the-trust-coffee",
  timezone: "Asia/Kolkata",
  defaultCurrency: "INR",
};
const ADMIN = {
  name: "Yuvraj Singh Solanki",
  email: "admin.support@thecrushcoffeeofficial.com",
};

// ---- Permissions: "module:action" -----------------------------------------
// The keys must match src/lib/auth/permission-keys.ts (a test compares the two).
const PERMISSIONS: Record<string, [key: string, description: string][]> = {
  organization: [
    ["org:read", "View company settings"],
    ["org:update", "Change company settings"],
    ["settings:security", "Change security settings"],
  ],
  integration: [
    ["integration:read", "View integration status"],
    ["integration:manage", "Manage CafeOS integration and API clients"],
  ],
  audit: [["audit:read", "View the audit log"]],
  user: [
    ["user:read", "View team members and their accounts"],
    ["user:invite_employee", "Invite Employee accounts"],
    ["user:manage_employee", "Deactivate and reactivate Employee accounts"],
    ["user:invite_hr", "Invite HR Manager accounts"],
    ["user:manage_hr", "Change, deactivate and reactivate HR Manager accounts"],
    ["user:manage_super_admin", "Grant, change and deactivate Super Admin access"],
  ],
  department: [
    ["department:read", "View departments"],
    ["department:manage", "Create, edit and remove departments"],
  ],
  job: [
    ["job:read", "View job openings"],
    ["job:create", "Create job openings"],
    ["job:update", "Edit job openings"],
    ["job:publish", "Publish or unpublish job openings"],
    ["job:close", "Close job openings"],
    ["job:delete", "Delete job openings"],
  ],
  candidate: [
    ["candidate:read", "View candidates"],
    ["candidate:create", "Add candidates manually"],
    ["candidate:update", "Edit candidate details and notes"],
    ["candidate:delete", "Delete candidates"],
  ],
  application: [
    ["application:read", "View applications"],
    ["application:create", "Create applications on behalf of candidates"],
    ["application:move_stage", "Move applications between stages"],
    ["application:assign", "Choose the HR person responsible for an application"],
    ["application:note", "Add internal notes"],
  ],
  document: [["document:read", "View and download candidate documents"]],
  form: [
    ["form:read", "View form templates"],
    ["form:manage", "Create and edit form templates"],
    ["form:assign", "Send forms to candidates"],
  ],
  interview: [
    ["interview:read", "View interviews"],
    ["interview:schedule", "Schedule interviews"],
    ["interview:update", "Reschedule or edit interviews"],
    ["interview:cancel", "Cancel interviews"],
  ],
  feedback: [
    ["feedback:submit", "Submit interview feedback"],
    ["feedback:read", "Read interview feedback"],
  ],
  decision: [
    ["decision:read", "View hiring decisions"],
    ["decision:make", "Record hiring decisions"],
  ],
  offer: [
    ["offer:read", "View offers"],
    ["offer:create", "Draft offers"],
    ["offer:issue", "Issue offers to candidates"],
    ["offer:withdraw", "Withdraw offers"],
  ],
  onboarding: [
    ["onboarding:read", "View onboarding records"],
    ["onboarding:manage", "Manage onboarding tasks and documents"],
    ["onboarding:approve", "Approve onboarding (triggers the CafeOS transfer)"],
  ],
  employee: [
    ["employee:read", "View employee records"],
    ["employee:manage", "Create and edit employee records"],
    ["assignment:manage", "Manage employee job and designation assignments"],
  ],
  attendance: [
    ["attendance:read", "View everyone's attendance"],
    ["attendance:manage", "Correct and manage attendance records"],
  ],
  leave: [
    ["leave:read", "View everyone's leave requests"],
    ["leave:approve", "Approve or reject leave requests"],
    ["leave:manage", "Set up leave types, holidays and balance adjustments"],
  ],
  task: [["task:manage", "Assign, review and cancel tasks"]],
  report: [["report:read", "View HR reports and dashboards"]],
  self: [
    ["self:profile_read", "View my own employee profile and work information"],
    ["self:profile_update", "Update my permitted personal details"],
    ["self:attendance_read", "View my own attendance"],
    ["self:attendance_clock", "Clock in and out, record breaks and ask for attendance corrections"],
    ["self:leave_apply", "Apply for leave"],
    ["self:leave_read", "View my own leave balance and requests"],
    ["notification:read", "Receive my notifications"],
    ["self:task", "See and work on my own tasks"],
  ],
};

const ALL_KEYS = Object.values(PERMISSIONS).flatMap((list) => list.map(([key]) => key));

// ---- The three roles: one shared definition (src/lib/auth/roles.ts) --------
const ROLES = ROLE_KEYS.map((key) => ({
  key,
  name: ROLE_LABELS[key],
  description: ROLE_DESCRIPTIONS[key],
  permissions: [...ROLE_PERMISSIONS[key]] as string[],
}));

// ---- Helpers ---------------------------------------------------------------
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(1); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function askNewPassword(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await askHidden("Choose a password for the admin account (min 12 characters): ");
    if (first.length < 12) {
      console.log("  Too short. Please use at least 12 characters.");
      continue;
    }
    const second = await askHidden("Type it again to confirm: ");
    if (first !== second) {
      console.log("  The two entries did not match. Try again.");
      continue;
    }
    return first;
  }
  throw new Error("Password was not set after 3 attempts. Nothing was created for the admin user.");
}

async function main() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL is missing from .env");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.MIGRATION_DATABASE_URL }),
  });

  try {
    // 1. Permissions
    for (const [module, list] of Object.entries(PERMISSIONS)) {
      for (const [key, description] of list) {
        await prisma.permission.upsert({
          where: { key },
          update: { module, description },
          create: { key, module, description },
        });
      }
    }
    console.log(`Permissions ready: ${ALL_KEYS.length}`);

    // 2. Roles and their permissions
    const permissionRows = await prisma.permission.findMany({ select: { id: true, key: true } });
    const permissionId = new Map(permissionRows.map((p) => [p.key, p.id]));
    for (const role of ROLES) {
      const saved = await prisma.role.upsert({
        where: { key: role.key },
        update: { name: role.name, description: role.description },
        create: { key: role.key, name: role.name, description: role.description, isSystem: true },
      });
      await prisma.rolePermission.createMany({
        data: role.permissions.map((key) => {
          const id = permissionId.get(key);
          if (!id) throw new Error(`Unknown permission in role ${role.key}: ${key}`);
          return { roleId: saved.id, permissionId: id };
        }),
        skipDuplicates: true,
      });
      // Exact lists: a permission a role should no longer have is taken away.
      await prisma.rolePermission.deleteMany({ where: { roleId: saved.id, permission: { key: { notIn: role.permissions } } } });
      console.log(`Role ready: ${role.key} (${role.permissions.length} permissions)`);
    }

    // 3. Admin user (ask for a password only if the user does not exist yet)
    const email = ADMIN.email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      console.log(`Admin user already exists: ${email} (password left unchanged)`);
    } else {
      const password = await askNewPassword();
      const passwordHash = await bcrypt.hash(password, 12);
      user = await prisma.user.create({
        data: { email, name: ADMIN.name, passwordHash, status: "ACTIVE" },
      });
      console.log(`Admin user created: ${email}`);
    }

    // 4. Organization (owned by the admin)
    let org = await prisma.organization.findUnique({ where: { slug: ORGANIZATION.slug } });
    if (org) {
      console.log(`Organization already exists: ${org.name}`);
    } else {
      org = await prisma.organization.create({
        data: { ...ORGANIZATION, ownerUserId: user.id },
      });
      await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          action: "organization.bootstrapped",
          entityType: "organization",
          entityId: org.id,
          metadata: { source: "prisma/seed.ts" },
        },
      });
      console.log(`Organization created: ${org.name}`);
    }

    // 5. Membership + Admin role
    const member = await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      update: {},
      create: { organizationId: org.id, userId: user.id, status: "ACTIVE", joinedAt: new Date() },
    });
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    await prisma.organizationMemberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId: adminRole.id } },
      update: {},
      create: { memberId: member.id, roleId: adminRole.id },
    });
    console.log("Super Admin role assigned. Seed finished.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error.message ?? error);
  process.exit(1);
});
