"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import CanonicalPlayersSection from "./CanonicalPlayersSection";
import CanonicalGenerateSection from "./CanonicalGenerateSection";

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

  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });

  async function loadPlayers() {
    setLoading(true);
    const res = await fetch(playersUrl, { cache: "no-store" });
    if (res.ok) {
      setPlayers(await res.json());
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPlayers();
    setSelected({});
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching every other canonical page's own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  function toggleSelected(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
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
        onMessage={setMessage}
        refreshPlayers={loadPlayers}
      />

      <CanonicalGenerateSection
        organizationSlug={organizationSlug}
        groupSlug={groupSlug}
        selectedIds={selectedIds}
        onMessage={setMessage}
      />
    </div>
  );
}
