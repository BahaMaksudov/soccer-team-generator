"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { applyImportedPlayerSelection } from "@/lib/telegramImportSelection";
import type { PublishedGeneration } from "@/lib/closeAndPostUi";
import {
  applySelectAllActive,
  countSelectedGoalkeepers,
  pruneSelection,
} from "@/lib/canonicalAdminState";
import CanonicalPlayersSection from "./CanonicalPlayersSection";
import CanonicalGenerateSection from "./CanonicalGenerateSection";
import CanonicalSettingsSection from "./CanonicalSettingsSection";
import CanonicalTelegramSection from "./CanonicalTelegramSection";

/**
 * Phase 2D.6D.2 — canonical tenant-bound Admin workspace: Player
 * management/selection + Generate preview, sharing ONE Player fetch
 * instead of two independent components each loading the same list
 * (Phase 2D.6D.2 §"avoid duplicate Player UI state"). This is new,
 * canonical-only code — the legacy AdminWorkspace.tsx (and its
 * PlayerSelection.tsx) are untouched and not imported here.
 *
 * Owns: the Player list/loading state, the selection checkboxes, and
 * the single shared success/error banner. Passes only
 * organizationSlug/groupSlug down to its children — never groupId/
 * organizationId/membershipId — and every fetch anywhere in this tree
 * is built via adminTenantApiPath(...), never a legacy flat
 * /api/admin/* URL.
 */

export type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
  rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  stamina: number;
  isActive: boolean;
};

/** Today's date as YYYY-MM-DD in the browser's local calendar (the
 * Generate date input's long-standing default). */
function todayYMD() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type ImportedPollResult = {
  selectedCount: number;
  skippedCount: number;
  generateDate: string | null;
};

export default function CanonicalAdminWorkspace({
  organizationSlug,
  groupSlug,
}: {
  organizationSlug: string;
  groupSlug: string;
}) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  // Phase 2D.6D.5D — the TeamGeneration published by THIS workspace's
  // current Generate → Publish flow (id from the canonical Publish
  // response). Close Poll & Post Teams is only offered for it; a new
  // Generate/Clear resets it. Local component state only.
  const [publishedGeneration, setPublishedGeneration] = useState<PublishedGeneration | null>(null);
  // Phase 2D.6D.5E.3 — Generate date lifted here so a Telegram poll
  // import can set it from the poll's persisted pollDate.
  const [generateDate, setGenerateDate] = useState<string>(todayYMD);

  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });

  async function loadPlayers() {
    setLoading(true);
    const res = await fetch(playersUrl, { cache: "no-store" });
    if (res.ok) {
      const list: Player[] = await res.json();
      setPlayers(list);
      // Phase 2D.6D.5E.3 — drop selected ids that were deleted or
      // deactivated; canonical Generate rejects the whole request if any
      // selected id is inactive/missing.
      setSelected((prev) => pruneSelection(prev, list));
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPlayers();
    setSelected({});
    setPublishedGeneration(null);
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching every other canonical page's own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  function toggleSelected(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function selectAllActive(checked: boolean) {
    setSelected((prev) => applySelectAllActive(prev, players, checked));
  }

  // Phase 2D.6D.5C — a successful Telegram poll import REPLACES the
  // current selection with the imported player ids, matching the
  // legacy AdminWorkspace.importFromTelegramPoll() semantics exactly
  // (it does not merge with whatever was previously checked).
  // Phase 2D.6D.5E.3 — imported ids that aren't active players here are
  // skipped (Generate would reject them), and the poll's persisted date,
  // when present, becomes the Generate date.
  function applyImportedPoll(ids: string[], pollDate: string | null): ImportedPollResult {
    const next = pruneSelection(applyImportedPlayerSelection(ids), players);
    setSelected(next);
    if (pollDate) setGenerateDate(pollDate);
    const selectedCount = Object.keys(next).length;
    return { selectedCount, skippedCount: new Set(ids).size - selectedCount, generateDate: pollDate };
  }

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  const selectedGoalkeeperCount = useMemo(
    () => countSelectedGoalkeepers(players, selectedIds),
    [players, selectedIds]
  );

  return (
    <div>
      {message && <div className="text-sm text-blue-700 mt-2">{message}</div>}

      <CanonicalPlayersSection
        organizationSlug={organizationSlug}
        groupSlug={groupSlug}
        players={players}
        loading={loading}
        selected={selected}
        onToggleSelected={toggleSelected}
        onSelectAllActive={selectAllActive}
        onMessage={setMessage}
        refreshPlayers={loadPlayers}
      />

      <CanonicalGenerateSection
        organizationSlug={organizationSlug}
        groupSlug={groupSlug}
        selectedIds={selectedIds}
        selectedGoalkeeperCount={selectedGoalkeeperCount}
        date={generateDate}
        onDateChange={setGenerateDate}
        onMessage={setMessage}
        publishedGeneration={publishedGeneration}
        onPublishedGenerationChange={setPublishedGeneration}
      />

      <CanonicalSettingsSection
        organizationSlug={organizationSlug}
        groupSlug={groupSlug}
        onMessage={setMessage}
      />

      <CanonicalTelegramSection
        organizationSlug={organizationSlug}
        groupSlug={groupSlug}
        players={players}
        onImportedPoll={applyImportedPoll}
        publishedGeneration={publishedGeneration}
      />
    </div>
  );
}
