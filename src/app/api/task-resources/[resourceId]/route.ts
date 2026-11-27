import { unstable_rethrow } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { errorResponse } from "@/lib/http/responses";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { recruitmentDeps } from "@/lib/recruitment/runtime";
import { logger } from "@/lib/security/logger";
import { readResource } from "@/lib/tasks/tasks";

// Reference files attached to a task leave the server only here.
// The person must be signed in and hold a task permission; row-level security shows the file only to someone who may see
// its task (HR of the organisation, or the person the task is assigned to). Every download is audited.
//
// The file is always sent as a download, never displayed inside our site: a document that contained a script could
// otherwise run with the signed-in person's access.
export async function GET(request: Request, ctx: RouteContext<"/api/task-resources/[resourceId]">) {
  try {
    const { resourceId } = await ctx.params;
    const auth = await getCurrentAuth();
    if (!auth) return errorResponse("unauthorized", 401);
    const file = await readResource(recruitmentDeps(request.headers), auth, resourceId);
    const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(file.bytes as BodyInit, {
      status: 200,
      headers: {
        "content-type": file.mimeType,
        "content-length": String(file.bytes.length),
        "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthError) return errorResponse(error.code, error.status);
    // Missing, someone else's, or not visible to this person: all answered the same way.
    if (error instanceof RecruitmentError) return errorResponse("invalid_request", 404);
    logger.error("tasks.resource_download_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return errorResponse("server_error", 500);
  }
}
