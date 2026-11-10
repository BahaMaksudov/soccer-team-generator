"use client";

import { roleLabel } from "@/lib/sports";
import { formatLongDateOnly } from "@/lib/dateOnly";
import type { GeneratedTeam } from "../types";
import { SHIRT_COLORS, isShirtColorId, shirtColorOf, teamsWithoutShirtColor, type ShirtColorId } from "@/lib/shirtColors";
import { ShirtColorSwatch } from "@/components/teams/ShirtColorBadge";

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
  onShirtColorChange,
}: {
  variant?: keyof typeof VARIANT;
  /** Preview only: lets the owner pick each team's shirt color (players never change). */
  onShirtColorChange?: (teamNumber: number, color: ShirtColorId) => void;
  previewTeams: GeneratedTeam[];
  previewDate: string;
  /** M7 — role labels come from the Group's sport. */
  sportKey: string;
}) {
  // UI-4 — team cards (stack on narrow screens); same content as before.
  const uncolored = onShirtColorChange ? teamsWithoutShirtColor(previewTeams) : [];
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

      {uncolored.length > 0 && (
        <p role="note" className="mx-4 mt-4 rounded-tbp-sm border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          There are {SHIRT_COLORS.length} shirt colors, so {uncolored.map((n) => `Team #${n}`).join(", ")} {uncolored.length === 1 ? "has" : "have"} no color. Use numbered bibs or
          another way to tell {uncolored.length === 1 ? "it" : "them"} apart.
        </p>
      )}
      <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Teams">
        {previewTeams.map((t, i) => {
          const color = shirtColorOf(t.shirtColor);
          const selectId = `shirt-color-${variant}-${t.teamNumber}`;
          return (
          <li key={t.teamNumber} className="min-w-0 rounded-tbp-xl border border-border bg-background p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              {color ? (
                <ShirtColorSwatch color={color.id} className="size-4" />
              ) : (
                <span className={i % 2 === 0 ? "size-2.5 rounded-full bg-team-a" : "size-2.5 rounded-full bg-team-b"} aria-hidden="true" />
              )}
              <span className="font-display font-extrabold">
                Team #{t.teamNumber}
                {color && <span className="font-semibold"> — {color.label} Shirts</span>}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{t.players.length} players</span>
            </div>
            {onShirtColorChange && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label htmlFor={selectId} className="text-xs font-semibold text-muted-foreground">
                  Shirt color
                </label>
                <select
                  id={selectId}
                  aria-label={`Shirt color for Team #${t.teamNumber}`}
                  value={isShirtColorId(t.shirtColor) ? t.shirtColor : ""}
                  onChange={(e) => isShirtColorId(e.target.value) && onShirtColorChange(t.teamNumber, e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-tbp-sm border border-input bg-card px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:text-sm"
                >
                  {!isShirtColorId(t.shirtColor) && <option value="">No color</option>}
                  {SHIRT_COLORS.map((c) => {
                    const takenBy = previewTeams.find((o) => o.teamNumber !== t.teamNumber && o.shirtColor === c.id);
                    return (
                      <option key={c.id} value={c.id} disabled={Boolean(takenBy)}>
                        {c.emoji} {c.label}
                        {takenBy ? ` (Team #${takenBy.teamNumber})` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
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
          );
        })}
      </ul>
    </div>
  );
}
