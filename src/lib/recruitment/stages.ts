// The candidate pipeline: which stages exist in this milestone and which moves are allowed.
// Pure rules (no database), so every one of them is unit tested.
//
//   Applied -> Under review -> Shortlisted -> Interview scheduled -> Interview completed -> Selected
//
//   - Forward moves may skip stages (a small team does not always use every step).
//   - Backward moves are allowed only with a reason (they are corrections).
//   - Rejected and Withdrawn can be reached from any of the stages above. Rejecting needs a reason.
//   - A rejected or withdrawn application can be brought back to an earlier stage, with a reason.
//   - The later stages in the database (offer, onboarding, joined) belong to future milestones and
//     cannot be reached or left from here.

export const ACTIVE_STAGES = ["APPLIED", "UNDER_REVIEW", "SHORTLISTED", "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED", "SELECTED"] as const;
export const CLOSED_STAGES = ["REJECTED", "WITHDRAWN"] as const;
export const PIPELINE_STAGES = [...ACTIVE_STAGES, ...CLOSED_STAGES] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
// Everything the database can hold, including stages owned by later milestones.
export type AnyStage = PipelineStage | "OFFER_ISSUED" | "OFFER_ACCEPTED" | "ONBOARDING" | "JOINED" | "OFFER_DECLINED";

export const STAGE_LABELS: Record<AnyStage, string> = {
  APPLIED: "Applied",
  UNDER_REVIEW: "Under review",
  SHORTLISTED: "Shortlisted",
  INTERVIEW_SCHEDULED: "Interview scheduled",
  INTERVIEW_COMPLETED: "Interview completed",
  SELECTED: "Selected",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  OFFER_ISSUED: "Offer issued",
  OFFER_ACCEPTED: "Offer accepted",
  ONBOARDING: "Onboarding",
  JOINED: "Joined",
  OFFER_DECLINED: "Offer declined",
};

export const isPipelineStage = (value: unknown): value is PipelineStage =>
  typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);

const isActive = (s: string): boolean => (ACTIVE_STAGES as readonly string[]).includes(s);
const order = (s: string): number => (ACTIVE_STAGES as readonly string[]).indexOf(s);

export const MAX_REASON_LENGTH = 1000;

export type MoveKind = "forward" | "backward" | "reject" | "withdraw" | "restore";

// What kind of move this is, or null when it is not allowed at all.
export function moveKind(from: AnyStage, to: AnyStage): MoveKind | null {
  if (from === to || !isPipelineStage(from) || !isPipelineStage(to)) return null;
  if (isActive(from) && to === "REJECTED") return "reject";
  if (isActive(from) && to === "WITHDRAWN") return "withdraw";
  if (!isActive(from)) return isActive(to) && to !== "SELECTED" ? "restore" : null;
  return order(to) > order(from) ? "forward" : "backward";
}

export const moveNeedsReason = (kind: MoveKind): boolean => kind === "backward" || kind === "reject" || kind === "restore";

export type MoveCheck = { ok: true; kind: MoveKind; reason: string | null } | { ok: false; message: string };

export function checkMove(from: AnyStage, to: AnyStage, rawReason: string | null | undefined): MoveCheck {
  const kind = moveKind(from, to);
  if (!kind) return { ok: false, message: `An application cannot move from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}.` };
  const reason = rawReason?.trim() ? rawReason.trim() : null;
  if (reason && reason.length > MAX_REASON_LENGTH) return { ok: false, message: `Keep the reason under ${MAX_REASON_LENGTH} characters.` };
  if (moveNeedsReason(kind) && !reason) {
    const why = kind === "reject" ? "Give a reason for rejecting this application." : kind === "restore" ? "Say why this application is being reopened." : "Say why this application is moving back a stage.";
    return { ok: false, message: why };
  }
  return { ok: true, kind, reason };
}

// The stages this application may move to next, in pipeline order.
export function allowedMoves(from: AnyStage): { to: PipelineStage; kind: MoveKind }[] {
  return PIPELINE_STAGES.flatMap((to) => {
    const kind = moveKind(from, to);
    return kind ? [{ to, kind }] : [];
  });
}
