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
  return (
    <div className="border rounded-2xl overflow-hidden bg-white shadow-sm mt-4">
      <div className="p-4 bg-gradient-to-r from-slate-50 to-white border-b">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-slate-900">{VARIANT[variant].title}</div>
            <div className="text-xs text-slate-500 mt-1">
              Date:{" "}
              {/* Date-only: formatted from UTC calendar parts, never the
                  browser's timezone (Phase 2D.6E.3B). */}
              <b>{formatLongDateOnly(previewDate)}</b>
            </div>
          </div>

          <div className="text-xs text-slate-500">
            {VARIANT[variant].tip}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-white sticky top-0">
            <tr className="text-slate-700">
              <th className="text-left p-3 w-28">Team</th>
              <th className="text-left p-3">Players</th>
            </tr>
          </thead>

          <tbody>
            {previewTeams.map((t) => (
              <tr key={t.teamNumber} className="border-t hover:bg-slate-50 transition">
                <td className="p-3 font-semibold text-slate-900">#{t.teamNumber}</td>
                <td className="p-3">
                  <ul className="list-disc pl-5 space-y-1">
                    {t.players.map((p) => (
                      <li key={p.id}>
                        {p.firstName} {p.lastName} — <span className="text-slate-600">{roleLabel(sportKey, p.position)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
