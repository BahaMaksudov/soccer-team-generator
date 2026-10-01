"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import TeamPreview from "@/app/admin/components/TeamPreview";
import type { GeneratedTeam } from "@/app/admin/types";
import {
  publishedGenerationFromPublishResponse,
  type PublishedGeneration,
} from "@/lib/closeAndPostUi";
import {
  deletePublishedPath,
  isYmd,
  publishedGenerationAfterDelete,
  roleCoverageMessage,
  selectedRoleCoverage,
} from "@/lib/canonicalAdminState";
import type { SportClientView } from "@/lib/sports";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6D.2 — canonical tenant-bound Generate preview.
 * Phase 2D.6D.3 — adds Publish, completing Players → Generate →
 * Preview → Publish on canonical, tenant-bound APIs only.
 *
 * Reuses the existing TeamPreview component as-is (pure presentational,
 * no API calls, no tenant coupling — safe to import unmodified). Does
 * NOT reuse GenerationControls: that component hard-codes a Publish
 * button wired to page-owned legacy state, so this section renders its
 * own compact date/team-count/Generate/Publish controls instead.
 *
 * Every request targets adminTenantApiPath(...) — never the legacy
 * flat /api/admin/generate or /api/admin/publish. Publish deliberately
 * omits pollId/closePoll/postToTelegram — the shared Publish core's
 * Telegram branch only activates when a pollId is sent, and this
 * canonical workspace has no Telegram affordance yet (out of scope
 * this phase), so it stays dormant here by construction, not by a
 * special code path.
 *
 * Phase 2D.6D.5D — still Telegram-free. After a successful Publish it
 * reports the saved TeamGeneration ({ id, date }) up to the workspace
 * so the separate Close Poll & Post Teams action can target exactly
 * that row; Generate and Clear reset it to null.
 *
 * Phase 2D.6D.5E.3 — the Generate date is owned by the workspace (so a
 * Telegram poll import can set it); the "Published" badge is derived
 * from the workspace's publishedGeneration; the legacy goalkeeper
 * warning is back; and Delete Published Teams calls the canonical
 * DELETE /publish?date=… (Group-scoped by the URL) after an explicit
 * inline confirmation. Deleting never touches Telegram.
 *
 * M7 — the goalkeeper note became sport-aware role coverage: the Group's
 * SportDefinition decides which roles are checked (soccer: goalkeepers,
 * volleyball: setters, flag football: quarterbacks, basketball: Bigs as
 * information only; Other: none) and supplies the labels.
 */
export default function CanonicalGenerateSection({
  organizationSlug,
  groupSlug,
  selectedIds,
  players,
  sport,
  date,
  onDateChange,
  onMessage,
  publishedGeneration,
  onPublishedGenerationChange,
}: {
  organizationSlug: string;
  groupSlug: string;
  selectedIds: string[];
  players: Player[];
  sport: SportClientView;
  date: string;
  onDateChange: (date: string) => void;
  onMessage: (msg: string | null) => void;
  publishedGeneration: PublishedGeneration | null;
  onPublishedGenerationChange: (generation: PublishedGeneration | null) => void;
}) {
  const [teamCount, setTeamCount] = useState(2);

  const [previewTeams, setPreviewTeams] = useState<GeneratedTeam[] | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<Array<{ code: string; roleKey?: string; count?: number }>>([]);
  const shortRoles = useMemo(
    () => selectedRoleCoverage(sport, players, selectedIds, teamCount).filter((c) => c.short),
    [sport, players, selectedIds, teamCount]
  );
  const [publishing, setPublishing] = useState(false);
  const published = publishedGeneration !== null;

  async function generate() {
    onMessage(null);
    onPublishedGenerationChange(null);
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
    setPreviewWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    onMessage("Preview generated. If it looks good, click Publish.");
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    setPreviewWarnings([]);
    onPublishedGenerationChange(null);
    onMessage("Preview cleared.");
  }

  async function publish() {
    if (!previewTeams || !previewDate) {
      onMessage("Generate a preview first, then publish.");
      return;
    }
    onMessage(null);
    setPublishing(true);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/publish" }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: previewDate, teams: previewTeams }),
    });
    const data = await res.json().catch(() => ({}));
    setPublishing(false);
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to publish");
      return;
    }
    onPublishedGenerationChange(publishedGenerationFromPublishResponse(data, previewDate));
    onMessage("✅ Published! The public page for this Group is updated.");
  }


  // --- Delete Published Teams (canonical, Group-scoped by URL) ---
  const [deleteDate, setDeleteDate] = useState<string>(() => publishedGeneration?.date ?? date);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  // Default the delete date to whatever was just published.
  useEffect(() => {
    if (publishedGeneration) setDeleteDate(publishedGeneration.date);
  }, [publishedGeneration]);

  async function deletePublishedTeams() {
    if (!isYmd(deleteDate)) {
      setDeleteMsg("Choose a date first.");
      return;
    }
    setDeleting(true);
    setDeleteMsg(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: deletePublishedPath(deleteDate) }), {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteMsg(data?.error ?? "Failed to delete published teams");
        return;
      }
      onPublishedGenerationChange(publishedGenerationAfterDelete(publishedGeneration, deleteDate));
      setDeleteMsg(
        data?.deleted
          ? `✅ Deleted the published teams for ${deleteDate}. Any teams message already posted to Telegram is not removed.`
          : `No published teams were found for ${deleteDate}.`
      );
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Generate Teams (Preview)</div>
      <p className="text-xs text-gray-500">
        Select players above, generate a preview, then publish it for this Group.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs">Date</label>
          <input
            type="date"
            className="border rounded px-2 py-1 text-sm"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
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
        <button
          className="bg-sky-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!previewTeams || publishing}
          onClick={publish}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
        {previewTeams && (
          <button className="bg-rose-600 text-white rounded px-3 py-1 text-sm" onClick={clearPreview}>
            Clear
          </button>
        )}
        {published && (
          <span className="text-xs px-2 py-1 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
            Published
          </span>
        )}
      </div>

      {selectedIds.length > 0 &&
        shortRoles.map((c) => (
          <div
            key={c.roleKey}
            className={
              c.warn
                ? "text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2"
                : "text-xs text-gray-600 bg-gray-50 border rounded px-3 py-2"
            }
          >
            Note: {roleCoverageMessage(sport, c, teamCount)}
          </div>
        ))}

      {previewWarnings
        .filter((w) => w.code === "UNKNOWN_ROLE")
        .map((w) => (
          <div key={`unknown-${w.roleKey}`} className="text-xs text-amber-700">
            {w.count} player(s) have a {sport.terminology.roleNoun.toLowerCase()} that isn&apos;t used in {sport.label} ({w.roleKey}); they were balanced as a general player.
          </div>
        ))}

      {previewTeams && previewDate && <TeamPreview previewTeams={previewTeams} previewDate={previewDate} sportKey={sport.key} />}

      <div className="pt-3 border-t space-y-2">
        <div className="text-sm font-medium">Delete Published Teams</div>
        <div className="text-xs text-gray-500">
          Removes this Group&apos;s published teams for one date from the public page. It does not delete or edit any
          teams message already posted to Telegram.
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs">Date</label>
            <input
              type="date"
              className="border rounded px-2 py-1 text-sm"
              value={deleteDate}
              onChange={(e) => {
                setDeleteDate(e.target.value);
                setConfirmingDelete(false);
                setDeleteMsg(null);
              }}
            />
          </div>
          {confirmingDelete ? (
            <>
              <span className="text-xs text-rose-700">
                Delete published teams for <b>{deleteDate}</b>? This cannot be undone.
              </span>
              <button
                className="bg-rose-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                disabled={deleting}
                onClick={deletePublishedTeams}
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                className="border rounded px-3 py-1 text-sm"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="border border-rose-600 text-rose-700 rounded px-3 py-1 text-sm disabled:opacity-50"
              disabled={!isYmd(deleteDate)}
              onClick={() => {
                setDeleteMsg(null);
                setConfirmingDelete(true);
              }}
            >
              Delete Published Teams…
            </button>
          )}
        </div>
        {deleteMsg && <div className="text-sm text-blue-700">{deleteMsg}</div>}
      </div>
    </div>
  );
}
