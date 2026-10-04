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
import BalanceIntelligence from "./BalanceIntelligence";
import type { BalanceAnalysis } from "@/lib/balanceAnalysis";
import type { BalanceMetrics } from "@/lib/balanceEngine";
import { applySwapBody } from "@/lib/balanceAnalysisUi";
import { assignmentKey, teamsPanelState, type TeamsPanelMode } from "@/lib/teamAssignment";

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
 * that row. (M9-A: it stays set after Regenerate/Clear/Apply Swap — the
 * published teams remain published until a new Publish or a delete.)
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
 * volleyball: setters, American Football: quarterbacks, basketball: Bigs as
 * information only; Other: none) and supplies the labels.
 *
 * M8-A — the preview shows deterministic Balance Intelligence (quality,
 * facts, best single swap). "Apply Swap" asks the server to re-validate and
 * apply the suggestion to the PREVIEW only; it never publishes or posts.
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
  matchId,
  initialPublishedTeams,
  onPanelModeChange,
}: {
  /** M9-A — lets the page hide Telegram team posting while an unpublished preview is on screen. */
  onPanelModeChange?: (mode: TeamsPanelMode) => void;
  /** M9-A — Generate for a Match: the date is the Match's, Publish links the teams to it, and delete-by-date is hidden. */
  matchId?: string;
  /** M9-A — the currently published teams (from the server), so a reload still shows them as published. */
  initialPublishedTeams?: GeneratedTeam[] | null;
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
  const [previewAnalysis, setPreviewAnalysis] = useState<BalanceAnalysis | null>(null);
  const [previewMetrics, setPreviewMetrics] = useState<BalanceMetrics | null>(null);
  const [applyingSwap, setApplyingSwap] = useState(false);
  const shortRoles = useMemo(
    () => selectedRoleCoverage(sport, players, selectedIds, teamCount).filter((c) => c.short),
    [sport, players, selectedIds, teamCount]
  );
  const [publishing, setPublishing] = useState(false);

  // M9-A — PUBLISHED teams (persisted; what players see) are separate from the
  // working PREVIEW. Generate/Regenerate, Apply Swap and Clear change only the
  // preview; only Publish replaces the published teams. Which one is shown is
  // decided from the actual assignments (src/lib/teamAssignment.ts).
  const [publishedTeams, setPublishedTeams] = useState<GeneratedTeam[] | null>(initialPublishedTeams ?? null);
  const initialKey = initialPublishedTeams ? assignmentKey(initialPublishedTeams) : null;
  useEffect(() => {
    if (initialPublishedTeams) setPublishedTeams(initialPublishedTeams);
    // Only when the server's published assignment itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);
  useEffect(() => {
    if (!publishedGeneration) setPublishedTeams(null); // e.g. published teams deleted
  }, [publishedGeneration]);
  const published = publishedGeneration !== null && publishedTeams !== null;
  // A preview for another date (legacy by-date flow) is not "the published version" of it.
  const previewYmd = previewDate ? previewDate.slice(0, 10) : null;
  const publishedForPreview = previewYmd && publishedGeneration && publishedGeneration.date !== previewYmd ? null : publishedTeams;
  const panel = teamsPanelState(previewTeams, previewTeams ? publishedForPreview : publishedTeams);
  useEffect(() => {
    onPanelModeChange?.(panel.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.mode]);

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
    setPreviewWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    setPreviewAnalysis(data.analysis ?? null);
    setPreviewMetrics(data.metrics ?? null);
    onMessage(published ? "New preview generated. Players still see the published teams until you publish." : "Preview generated. If it looks good, click Publish.");
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    setPreviewWarnings([]);
    setPreviewAnalysis(null);
    setPreviewMetrics(null);
    onMessage(published ? "Preview cleared. The published teams are unchanged." : "Preview cleared.");
  }

  async function applySuggestedSwap() {
    if (!previewTeams || !previewAnalysis?.bestSwap || applyingSwap) return;
    setApplyingSwap(true);
    onMessage(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/generate/swap" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applySwapBody(previewTeams, previewAnalysis)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.analysis) {
        setPreviewAnalysis(data.analysis);
        if (data.metrics) setPreviewMetrics(data.metrics);
        onMessage(data.error ?? "The suggestion changed. Review the latest suggestion.");
        return;
      }
      if (!res.ok) {
        onMessage(data?.error ?? "Could not apply the swap.");
        return;
      }
      setPreviewTeams(data.teams);
      setPreviewAnalysis(data.analysis ?? null);
      setPreviewMetrics(data.metrics ?? null);
      onMessage("Swap applied to the preview. Publish when you're happy with the teams.");
    } finally {
      setApplyingSwap(false);
    }
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
      body: JSON.stringify(matchId ? { date: previewDate, teams: previewTeams, matchId } : { date: previewDate, teams: previewTeams }),
    });
    const data = await res.json().catch(() => ({}));
    setPublishing(false);
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to publish");
      return;
    }
    onPublishedGenerationChange(publishedGenerationFromPublishResponse(data, previewDate));
    setPublishedTeams(previewTeams);
    onMessage("✅ Published! The public page for this Group is updated. Nothing was sent to Telegram.");
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
    <div className="mt-4 space-y-3 rounded-tbp-xl border border-border bg-background/60 p-4">
      <div className="font-display font-extrabold">Generate Teams (Preview)</div>
      <p className="text-xs text-muted-foreground">
        Select players above, generate a preview, then publish it for this Group.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        {!matchId && (
          <div>
            <label className="block text-xs font-semibold" htmlFor="generate-date">Date</label>
            <input
              id="generate-date"
              type="date"
              className="h-10 rounded-tbp-sm border border-input bg-card px-2 text-sm"
              value={date}
              onChange={(e) => onDateChange(e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold" htmlFor={matchId ? "generate-team-count-match" : "generate-team-count"}>Number of teams</label>
          <input
            id={matchId ? "generate-team-count-match" : "generate-team-count"}
            type="number"
            min={2}
            className="h-10 w-24 rounded-tbp-sm border border-input bg-card px-2 text-sm"
            value={teamCount}
            onChange={(e) => setTeamCount(Number(e.target.value))}
          />
        </div>
        <button
          type="button"
          className="inline-flex min-h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={selectedIds.length === 0}
          onClick={generate}
        >
          {panel.generateLabel} (Selected: {selectedIds.length})
        </button>
        <button
          type="button"
          className="inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-foreground hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!panel.canPublish || publishing}
          onClick={publish}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
        {previewTeams && (
          <button type="button" className="inline-flex min-h-10 items-center rounded-full border border-input bg-card px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={clearPreview}>
            Clear Preview
          </button>
        )}
        {published && panel.badge === "Published" && (
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
            Published
          </span>
        )}
        {published && panel.badge === "Published version exists" && (
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
            Published version exists
          </span>
        )}
      </div>

      {selectedIds.length > 0 &&
        shortRoles.map((c) => (
          <div
            key={c.roleKey}
            className={
              c.warn
                ? "rounded-tbp-sm border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-foreground"
                : "rounded-tbp-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
            }
          >
            Note: {roleCoverageMessage(sport, c, teamCount)}
          </div>
        ))}

      {previewWarnings
        .filter((w) => w.code === "UNKNOWN_ROLE")
        .map((w) => (
          <div key={`unknown-${w.roleKey}`} className="text-xs text-accent-foreground">
            {w.count} player(s) have a {sport.terminology.roleNoun.toLowerCase()} that isn&apos;t used in {sport.label} ({w.roleKey}); they were balanced as a general player.
          </div>
        ))}

      {previewTeams && previewAnalysis && (
        <BalanceIntelligence
          analysis={previewAnalysis}
          metrics={previewMetrics}
          teams={previewTeams}
          sport={sport}
          applying={applyingSwap}
          onApplySwap={applySuggestedSwap}
        />
      )}

      {previewTeams && previewDate && (
        <TeamPreview
          variant={panel.mode === "published" ? "published" : panel.mode === "published_with_new_preview" ? "new_preview" : "preview"}
          previewTeams={previewTeams}
          previewDate={previewDate}
          sportKey={sport.key}
        />
      )}
      {/* M9-A — one full table at a time: while a different preview is open, the
          published teams are summarised here instead of shown as a second table. */}
      {panel.publishedVersionNote && (
        <div className="rounded-tbp-sm border border-border bg-muted px-3 py-2 text-sm">
          ✓ A published version already exists. Players still see the published teams until you click Publish;
          publishing this preview replaces them.
        </div>
      )}
      {publishedTeams && publishedGeneration && (panel.showPublishedTable || (previewTeams && !publishedForPreview)) && (
        <TeamPreview variant="published" previewTeams={publishedTeams} previewDate={publishedGeneration.date} sportKey={sport.key} />
      )}

      {!matchId && (
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
      )}
    </div>
  );
}
