import { handleLogout } from "@/lib/auth/handlers";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { guarded } from "@/lib/http/handler";

export const POST = guarded("logout", (request) => handleLogout(request, getAuthRuntime()));
