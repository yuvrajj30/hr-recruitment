// ============================================================================
// Seed script: creates the minimum data needed to log in for the first time.
//   1. Permissions (the list of things a person can be allowed to do)
//   2. The four built-in roles, each linked to its permissions
//   3. The first company (organization), its owner and the first Admin user
//
// Safe to run more than once: anything that already exists is left alone.
// The admin password is typed when the script runs. It is never saved in any
// file, and only a bcrypt hash of it goes into the database.
// ============================================================================
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

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
const PERMISSIONS: Record<string, [key: string, description: string][]> = {
  organization: [
    ["org:read", "View company settings"],
    ["org:update", "Change company settings"],
  ],
  member: [
    ["member:read", "View team members"],
    ["member:invite", "Invite new team members"],
    ["member:update", "Edit or suspend team members"],
    ["member:remove", "Remove team members"],
    ["member:assign_role", "Change a member's roles"],
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
    ["candidate:read", "View all candidates"],
    ["candidate:read_assigned", "View only candidates assigned to me"],
    ["candidate:create", "Add candidates manually"],
    ["candidate:update", "Edit candidate details"],
    ["candidate:delete", "Delete candidates"],
  ],
  application: [
    ["application:read", "View all applications"],
    ["application:read_assigned", "View only applications assigned to me"],
    ["application:create", "Create applications on behalf of candidates"],
    ["application:move_stage", "Move applications between stages"],
    ["application:assign", "Assign a recruiter to an application"],
    ["application:note", "Add internal notes"],
  ],
  form: [
    ["form:read", "View form templates"],
    ["form:manage", "Create and edit form templates"],
    ["form:assign", "Send forms to candidates"],
  ],
  interview: [
    ["interview:read", "View all interviews"],
    ["interview:read_assigned", "View only interviews I take part in"],
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
  integration: [
    ["integration:read", "View integration status"],
    ["integration:manage", "Manage CafeOS integration and API clients"],
  ],
  report: [["report:read", "View reports and dashboards"]],
  audit: [["audit:read", "View the audit log"]],
};

const ALL_KEYS = Object.values(PERMISSIONS).flatMap((list) => list.map(([key]) => key));

// ---- Roles and which permissions each one gets -----------------------------
const ROLES: { key: string; name: string; description: string; permissions: string[] }[] = [
  {
    key: "ADMIN",
    name: "Admin",
    description: "Full control of the company's recruitment workspace",
    permissions: ALL_KEYS,
  },
  {
    key: "HR_MANAGER",
    name: "HR Manager",
    description: "Runs hiring end to end; cannot change company settings or integrations",
    permissions: ALL_KEYS.filter(
      (k) =>
        ![
          "org:update",
          "member:update",
          "member:remove",
          "member:assign_role",
          "integration:manage",
          "job:delete",
          "candidate:delete",
        ].includes(k) && !k.endsWith("_assigned"),
    ),
  },
  {
    key: "RECRUITER",
    name: "Recruiter",
    description: "Sources and moves candidates through the pipeline",
    permissions: [
      "department:read",
      "job:read",
      "job:create",
      "job:update",
      "job:publish",
      "candidate:read",
      "candidate:create",
      "candidate:update",
      "application:read",
      "application:create",
      "application:move_stage",
      "application:note",
      "form:read",
      "form:assign",
      "interview:read",
      "interview:schedule",
      "interview:update",
      "interview:cancel",
      "feedback:read",
      "decision:read",
      "offer:read",
      "onboarding:read",
    ],
  },
  {
    key: "INTERVIEWER",
    name: "Interviewer",
    description: "Sees only their own interviews and submits feedback",
    permissions: [
      "candidate:read_assigned",
      "application:read_assigned",
      "interview:read_assigned",
      "feedback:submit",
    ],
  },
];

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
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    await prisma.organizationMemberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId: adminRole.id } },
      update: {},
      create: { memberId: member.id, roleId: adminRole.id },
    });
    console.log("Admin role assigned. Seed finished.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error.message ?? error);
  process.exit(1);
});
