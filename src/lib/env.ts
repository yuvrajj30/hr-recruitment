import "server-only";
import { z } from "zod";

// Every setting the app needs is checked here, once, with clear error messages.
// The app refuses to start with missing or unsafe settings instead of failing later.

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgresql:// address");

const usernameOf = (url: string) => decodeURIComponent(new URL(url).username);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // The running app connects with the restricted account (hr_runtime).
    DATABASE_URL: postgresUrl,
    // Only migrations and seeding use the owner account (hr_app). The running app never needs it.
    MIGRATION_DATABASE_URL: postgresUrl.optional(),
    DB_OWNER_ROLE: z.string().min(1).default("hr_app"),

    // Secret used to scramble login identifiers before they are stored (HMAC).
    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),

    // Where this app is served from. Used for the cross-site request (CSRF) check.
    APP_ORIGIN: z.string().url(),

    // Session timeouts (approved: 60 minutes idle, 12 hours absolute).
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    // last_seen_at is written at most once per this many seconds per session.
    SESSION_TOUCH_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(900).default(60),

    // How many trusted reverse proxies sit in front of the app (0 = none).
    // Client IP headers are ONLY believed when this is above 0.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    CLIENT_IP_HEADER: z
      .string()
      .min(1)
      .default("x-forwarded-for")
      .transform((v) => v.trim().toLowerCase()),

    // Retention for rows used only for rate limiting and housekeeping.
    LOGIN_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_ABSOLUTE_HOURS * 60 < env.SESSION_IDLE_MINUTES) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_ABSOLUTE_HOURS"],
        message: "absolute timeout must not be shorter than the idle timeout",
      });
    }
    if (usernameOf(env.DATABASE_URL) === env.DB_OWNER_ROLE) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: `must use the restricted runtime account, not the owner account "${env.DB_OWNER_ROLE}"`,
      });
    }
    if (env.MIGRATION_DATABASE_URL && usernameOf(env.MIGRATION_DATABASE_URL) !== env.DB_OWNER_ROLE) {
      ctx.addIssue({
        code: "custom",
        path: ["MIGRATION_DATABASE_URL"],
        message: `must use the owner account "${env.DB_OWNER_ROLE}"`,
      });
    }
    if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "must be an https:// address in production",
      });
    }
  });

export type Env = z.infer<typeof schema>;

// Thrown when a setting is missing or unsafe. Its message lists setting NAMES and problems only,
// never values, so it is safe to show in logs.
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    // Only setting NAMES and problems are listed, never the values.
    throw new EnvError(`Invalid environment settings:\n${lines.join("\n")}`);
  }
  return result.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
