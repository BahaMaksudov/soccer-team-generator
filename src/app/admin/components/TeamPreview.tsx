"use client";

import { roleLabel } from "@/lib/sports";
import { formatLongDateOnly } from "@/lib/dateOnly";
import type { GeneratedTeam } from "../types";

/** Renders a team assignment. Purely presentational — previewTeams/
 * previewDate stay page-owned (generate/publish/clear all write them).
 * M9-A: `variant` says WHAT is shown, decided from the actual assignments
 * (src/lib/teamAssignment.ts), never from button clicks:
 *   preview      an unpublished preview (nothing published yet)
 *   new_preview  an unpublished preview that differs from the published teams
 *   published    the published teams (what players see) */
const VARIANT = {
  preview: { title: "Preview — not published", tip: <>If it looks good, click <b>Publish</b>.</> },
  new_preview: { title: "New preview — not published", tip: <>Players still see the published teams until you click <b>Publish</b>.</> },
  published: { title: "Published teams", tip: <>Players see these teams. Posting to Telegram is a separate step.</> },
} as const;
export default function TeamPreview({
  previewTeams,
  previewDate,
  sportKey,
  variant = "preview",
}: {
  variant?: keyof typeof VARIANT;
  previewTeams: GeneratedTeam[];
  previewDate: string;
  /** M7 — role labels come from the Group's sport. */
  sportKey: string;
}) {
  // UI-4 — team cards (stack on narrow screens); same content as before.
  return (
    <div className="mt-4 overflow-hidden rounded-tbp-2xl border border-border bg-card shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/50 p-4">
        <div>
          <div className="font-display font-extrabold">{VARIANT[variant].title}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Date:{" "}
            {/* Date-only: formatted from UTC calendar parts, never the
                browser's timezone (Phase 2D.6E.3B). */}
            <b>{formatLongDateOnly(previewDate)}</b>
          </div>
        </div>

        <div className="text-xs text-muted-foreground">{VARIANT[variant].tip}</div>
      </div>

      <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Teams">
        {previewTeams.map((t, i) => (
          <li key={t.teamNumber} className="min-w-0 rounded-tbp-xl border border-border bg-background p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className={i % 2 === 0 ? "size-2.5 rounded-full bg-team-a" : "size-2.5 rounded-full bg-team-b"} aria-hidden="true" />
              <span className="font-display font-extrabold">Team #{t.teamNumber}</span>
              <span className="ml-auto text-xs text-muted-foreground">{t.players.length} players</span>
            </div>
            <ul className="space-y-1">
              {t.players.map((p) => (
                <li key={p.id} className="flex min-w-0 items-baseline justify-between gap-2 rounded-tbp-sm bg-muted px-2.5 py-1.5 text-sm">
                  <span className="truncate font-medium">
                    {p.firstName} {p.lastName}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{roleLabel(sportKey, p.position)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
