import { Badge } from "@/components/ui/badge";
import {
  DECISION_LABELS,
  type DecisionOutcome,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  type InterviewStatus,
  type InterviewType,
  RECOMMENDATION_LABELS,
  type Recommendation,
} from "@/lib/interviews/rules";

// Small display pieces shared by the interview screens (no client code, no data access).

const STATUS_TONES = { SCHEDULED: "accent", COMPLETED: "success", NO_SHOW: "warning", CANCELLED: "neutral" } as const;
export function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{INTERVIEW_STATUS_LABELS[status]}</Badge>;
}

const RECOMMENDATION_TONES = { STRONGLY_RECOMMEND: "success", RECOMMEND: "success", HOLD: "warning", REJECT: "danger" } as const;
export function RecommendationBadge({ value }: { value: Recommendation }) {
  return <Badge tone={RECOMMENDATION_TONES[value]}>{RECOMMENDATION_LABELS[value]}</Badge>;
}

const DECISION_TONES = { SELECTED: "success", ON_HOLD: "warning", REJECTED: "danger" } as const;
export function DecisionBadge({ outcome }: { outcome: DecisionOutcome }) {
  return <Badge tone={DECISION_TONES[outcome]}>{DECISION_LABELS[outcome]}</Badge>;
}

export function typeLabel(type: InterviewType): string {
  return INTERVIEW_TYPE_LABELS[type];
}

// "Round 2 · Practical test" or "Round 1".
export function roundTitle(round: number, name: string | null): string {
  return name ? `Round ${round} · ${name}` : `Round ${round}`;
}

// "20 Nov 2026, 3:30 pm – 4:15 pm" (or both dates when it runs past midnight), in the organisation's time zone.
export function formatSlot(start: Date, end: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  return day(start) === day(end) ? `${day(start)}, ${time(start)} – ${time(end)}` : `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
}

export function durationMinutes(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}
