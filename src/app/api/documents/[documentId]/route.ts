import { unstable_rethrow } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { getCurrentAuth } from "@/lib/auth/server-session";
import { errorResponse } from "@/lib/http/responses";
import { readDocument } from "@/lib/recruitment/documents";
import { RecruitmentError } from "@/lib/recruitment/errors";
import { recruitmentDeps } from "@/lib/recruitment/runtime";
import { logger } from "@/lib/security/logger";

// The ONLY way a candidate's file leaves the server.
// The person must be signed in, hold document:read, belong to the file's organisation and be allowed
// to see the application it came with (all checked in readDocument). Every download is audited.
//
// The file is always sent as a download, never displayed inside our site: a document that
// contained a script could otherwise run with the signed-in person's access.
export async function GET(request: Request, ctx: RouteContext<"/api/documents/[documentId]">) {
  try {
    const { documentId } = await ctx.params;
    const auth = await getCurrentAuth();
    if (!auth) return errorResponse("unauthorized", 401);
    const file = await readDocument(recruitmentDeps(request.headers), auth, documentId);
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
    logger.error("recruitment.document_download_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return errorResponse("server_error", 500);
  }
}
