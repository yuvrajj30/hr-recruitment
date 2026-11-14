import { z } from "zod";
import { REQUEST_LIMITS } from "./config";

// Shape check for what the browser sends. Nothing here looks at the database.

export const loginBodySchema = z
  .object({
    // Spaces around the address are ignored and capitals do not matter.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(REQUEST_LIMITS.maxEmailLength)
      .pipe(z.email()),
    // The password is NOT trimmed or changed in any way.
    password: z.string().min(1).max(REQUEST_LIMITS.maxPasswordLength),
  })
  .strict();

export type LoginBody = z.infer<typeof loginBodySchema>;
