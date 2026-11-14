import { connection } from "next/server";
import { handleSession } from "@/lib/auth/handlers";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { guarded } from "@/lib/http/handler";

export const GET = guarded("session", async (request) => {
  // The answer depends on the visitor's cookie, so it must never be prepared in advance at build time.
  await connection();
  return handleSession(request, getAuthRuntime());
});
