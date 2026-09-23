"use client";

import { positionLabel } from "@/lib/labels";
import type { GeneratedTeam } from "../types";

/** Renders the not-yet-published preview. Purely presentational —
 * previewTeams/previewDate stay page-owned (generate/publish/clear all
 * write them). */
export default function TeamPreview({
  previewTeams,
  previewDate,
}: {
  previewTeams: GeneratedTeam[];
  previewDate: string;
}) {
  return (
    <div className="border rounded-2xl overflow-hidden bg-white shadow-sm mt-4">
      <div className="p-4 bg-gradient-to-r from-slate-50 to-white border-b">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-slate-900">Preview (not published yet)</div>
            <div className="text-xs text-slate-500 mt-1">
              Date:{" "}
              <b>
                {new Date(previewDate).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </b>
            </div>
          </div>

          <div className="text-xs text-slate-500">
            Tip: If it looks good, click <b>Publish</b>.
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
                        {p.firstName} {p.lastName} — <span className="text-slate-600">{positionLabel(p.position)}</span>
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
