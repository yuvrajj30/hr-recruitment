"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";

// Shown to candidates when a careers address does not lead anywhere: a job that was filled, closed,
// unpublished or never existed, or an organisation address that is wrong. Candidates have no account,
// so this points them back to the open jobs, never to the staff dashboard.
export default function CareersNotFound() {
  const params = useParams<{ orgSlug?: string; jobSlug?: string }>();
  const orgSlug = typeof params.orgSlug === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(params.orgSlug) ? params.orgSlug : null;
  const isJob = typeof params.jobSlug === "string";
  return (
    <div className="py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-fg">{isJob ? "This job is no longer available" : "Careers page not found"}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
        {isJob
          ? "It may have been filled or closed to new applications. Other open jobs are listed on the careers page."
          : "Check the address you were given. It may have been typed incorrectly."}
      </p>
      {isJob && orgSlug && (
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <Link href={`/careers/${orgSlug}`}>See open jobs</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
