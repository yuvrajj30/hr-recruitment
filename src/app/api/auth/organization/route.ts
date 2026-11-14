import { handleSwitchOrganization } from "@/lib/auth/handlers";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { guarded } from "@/lib/http/handler";

export const POST = guarded("organization", (request) => handleSwitchOrganization(request, getAuthRuntime()));
