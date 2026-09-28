"use client";

import { useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import TeamPreview from "@/app/admin/components/TeamPreview";
import type { GeneratedTeam } from "@/app/admin/types";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6D.2 — canonical tenant-bound Generate preview.
 *
 * Reuses the existing TeamPreview component as-is (pure presentational,
 * no API calls, no tenant coupling — safe to import unmodified). Does
 * NOT reuse GenerationControls: that component hard-codes a Publish
 * button, and Publish is explicitly out of scope this phase — showing
 * a non-functional Publish control would be misleading, so this
 * section renders its own compact date/team-count/Generate controls
 * instead.
 *
 * Every request targets adminTenantApiPath(...) — never the legacy
 * flat /api/admin/generate. Generated results are preview-only in
 * this phase; refresh/navigation may lose them (acceptable per scope).
 */
export default function CanonicalGenerateSection({
  organizationSlug,
  groupSlug,
  selectedIds,
  onMessage,
}: {
  organizationSlug: string;
  groupSlug: string;
  selectedIds: string[];
  onMessage: (msg: string | null) => void;
}) {
  const [teamCount, setTeamCount] = useState(2);
  const [date, setDate] = useState<string>(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  });

  const [previewTeams, setPreviewTeams] = useState<GeneratedTeam[] | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);

  async function generate() {
    onMessage(null);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/generate" }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamCount, date: new Date(date).toISOString(), selectedIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to generate");
      return;
    }
    setPreviewTeams(data.teams);
    setPreviewDate(data.date);
    onMessage("Preview generated. (Publish is not yet available on this canonical workspace.)");
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    onMessage("Preview cleared.");
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Generate Teams (Preview)</div>
      <p className="text-xs text-gray-500">
        Select players above, then generate a preview. Publishing is not yet available on this canonical workspace.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs">Date</label>
          <input
            type="date"
            className="border rounded px-2 py-1 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs">Number of teams</label>
          <input
            type="number"
            min={2}
            className="border rounded px-2 py-1 text-sm w-24"
            value={teamCount}
            onChange={(e) => setTeamCount(Number(e.target.value))}
          />
        </div>
        <button
          className="bg-emerald-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={selectedIds.length === 0}
          onClick={generate}
        >
          Generate (Selected: {selectedIds.length})
        </button>
        {previewTeams && (
          <button className="bg-rose-600 text-white rounded px-3 py-1 text-sm" onClick={clearPreview}>
            Clear
          </button>
        )}
      </div>

      {previewTeams && previewDate && <TeamPreview previewTeams={previewTeams} previewDate={previewDate} />}
    </div>
  );
}
