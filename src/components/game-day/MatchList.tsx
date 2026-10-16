import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { OverviewMatch } from "@/lib/groupOverview";
import { focusRing, PhasePill, ResultSummary, StateChip } from "./parts";
import { cn } from "@/lib/cn";
import { matchCommunityLine, NO_COMMUNITY_LABEL } from "@/lib/matchCommunityLabel";

/** UI-4 — list of real Matches; each row opens its canonical Match workspace. */
export function MatchList({ matches, emptyText }: { matches: OverviewMatch[]; emptyText: string }) {
  if (matches.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-tbp-xl border border-border bg-card">
      {matches.map((m) => {
        const time = formatStartTime(m.startTime);
        const line = matchCommunityLine(m.communityName, m.locationName);
        return (
          <li key={m.id}>
            <Link href={m.href} className={cn("flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/60", focusRing, "focus-visible:ring-inset focus-visible:ring-offset-0")}>
              <span className="min-w-0 flex-1 basis-48">
                <span className="block truncate font-semibold">
                  {formatLongDateOnly(m.date)}
                  {time ? ` · ${time}` : ""}
                </span>
                {/* The Match's own Community, then the venue: "UCCNE - FC (Indoor Soccer) · ForeKicks". */}
                <span className="block truncate text-sm text-muted-foreground" title={line.text}>
                  {line.community ? <span className="font-medium text-foreground/80">{line.community}</span> : <span className="italic">{NO_COMMUNITY_LABEL}</span>}
                  {line.venue ? ` · ${line.venue}` : ""}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {m.publishedResult && (m.publishedResult.fixtures.length > 0 || m.publishedResult.legacyStandings) ? (
                  <ResultSummary result={m.publishedResult} />
                ) : m.status !== "CANCELED" && !m.upcoming ? (
                  <StateChip tone={m.resultSaved ? "pending" : "neutral"}>{m.resultSaved ? "Result not published" : "No result yet"}</StateChip>
                ) : m.upcoming ? (
                  <StateChip tone={m.teamsPublished ? "done" : "neutral"}>{m.teamsPublished ? "Teams published" : "Teams not published"}</StateChip>
                ) : null}
                <PhasePill phase={m.lifecycle.phase} label={m.lifecycle.phaseLabel} />
                {m.lifecycle.next && <span className="text-sm font-semibold text-primary">Next: {m.lifecycle.next.label}</span>}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
