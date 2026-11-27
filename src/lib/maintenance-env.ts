import "server-only";
import { z } from "zod";
import { EnvError } from "@/lib/env";

// Settings of the scheduled housekeeping job (scripts/privacy-retention.ts), and ONLY of that job.
//
// The job connects as its own database account, hr_maintenance: the only account allowed to run the housekeeping
// functions (candidate removal, private-file removal, attendance clean-up, rota generation, leave balances, task
// reminders; see the maintenance_identity migration). Its connection lives in .env.maintenance, a file Next.js never
// loads, so the web app does not have it; the web app's own settings check (src/lib/env.ts) refuses to start if it is
// given MAINTENANCE_DATABASE_URL anyway.

const usernameOf = (url: string) => decodeURIComponent(new URL(url).username);

const schema = z
  .object({
    MAINTENANCE_DATABASE_URL: z
      .string({ error: "is missing: put the hr_maintenance connection in .env.maintenance" })
      .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgresql:// address"),
    DB_MAINTENANCE_ROLE: z.string().min(1).default("hr_maintenance"),
    DB_OWNER_ROLE: z.string().min(1).default("hr_app"),
    DB_SESSION_TIME_ZONE: z.enum(["UTC"]).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.DB_MAINTENANCE_ROLE === env.DB_OWNER_ROLE) {
      ctx.addIssue({ code: "custom", path: ["DB_MAINTENANCE_ROLE"], message: "must not be the owner account" });
      return;
    }
    if (usernameOf(env.MAINTENANCE_DATABASE_URL) !== env.DB_MAINTENANCE_ROLE) {
      ctx.addIssue({
        code: "custom",
        path: ["MAINTENANCE_DATABASE_URL"],
        message: `must use the maintenance account "${env.DB_MAINTENANCE_ROLE}" (not the app's or the owner's account)`,
      });
    }
  });

export type MaintenanceEnv = z.infer<typeof schema>;

export function parseMaintenanceEnv(source: Record<string, string | undefined>): MaintenanceEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Setting NAMES and problems only, never the values.
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new EnvError(`Invalid maintenance job settings:\n${lines.join("\n")}`);
  }
  return result.data;
}

// The maintenance-only settings found in a settings file the web app also reads (.env): they must not be there.
export function maintenanceSecretsIn(parsed: Record<string, string | undefined>): string[] {
  return ["MAINTENANCE_DATABASE_URL"].filter((k) => parsed[k] !== undefined);
}
