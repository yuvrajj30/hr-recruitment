import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { JOB_STATUS_LABELS, type JobStatus } from "@/lib/recruitment/job-status";
import { type AnyStage, STAGE_LABELS } from "@/lib/recruitment/stages";

const STATUS_TONES = { DRAFT: "neutral", PUBLISHED: "success", CLOSED: "warning", ARCHIVED: "neutral" } as const;

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{JOB_STATUS_LABELS[status]}</Badge>;
}

export function NoAccess({ what }: { what: string }) {
  return (
    <Card>
      <EmptyState icon={Lock} title="You do not have access" description={`Your role does not include permission to ${what}. Ask an administrator if you need it.`} />
    </Card>
  );
}

const STAGE_TONES: Record<AnyStage, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  APPLIED: "neutral",
  UNDER_REVIEW: "accent",
  SHORTLISTED: "accent",
  INTERVIEW_SCHEDULED: "warning",
  INTERVIEW_COMPLETED: "warning",
  SELECTED: "success",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
  OFFER_ISSUED: "success",
  OFFER_ACCEPTED: "success",
  ONBOARDING: "success",
  JOINED: "success",
  OFFER_DECLINED: "neutral",
};

export function StageBadge({ stage }: { stage: AnyStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}
