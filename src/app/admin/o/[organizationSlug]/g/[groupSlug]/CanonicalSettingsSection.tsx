"use client";

import { useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";

/**
 * Phase 2D.6D.4 — canonical tenant-bound Group settings (teamName,
 * balanceWeights). Self-contained, mirroring the legacy app's own
 * shape: TeamSettings.tsx (Admin page) and /admin/settings/page.tsx
 * (balance weights) are each independent, self-fetching components
 * with no shared state — nothing else in the canonical workspace
 * reads these values, so there's no benefit to lifting this state up
 * into CanonicalAdminWorkspace the way Players/Generate share their
 * Player list.
 *
 * Every request targets adminTenantApiPath(...) — never the legacy
 * flat /api/admin/settings/*. Field labels/controls mirror the
 * existing TeamSettings.tsx and /admin/settings/page.tsx contracts
 * (same validation, same stamina-coefficient/position-weight shape),
 * not a redesign.
 */

type Weights = {
  staminaCoef: number;
  positionWeights: Record<string, number>;
};

const POSITIONS = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];

export default function CanonicalSettingsSection({
  organizationSlug,
  groupSlug,
  onMessage,
}: {
  organizationSlug: string;
  groupSlug: string;
  onMessage: (msg: string | null) => void;
}) {
  const teamNameUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/settings/team-name" });
  const balanceWeightsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/settings/balance-weights" });

  const [teamName, setTeamName] = useState("");
  const [teamNameSaving, setTeamNameSaving] = useState(false);

  const [weights, setWeights] = useState<Weights | null>(null);
  const [weightsSaving, setWeightsSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(teamNameUrl, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTeamName(data.teamName || "");
      }
    })();

    (async () => {
      const res = await fetch(balanceWeightsUrl, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setWeights(data.weights);
      }
    })();
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching every other canonical component's own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  async function saveTeamName() {
    onMessage(null);
    const name = teamName.trim();
    if (!name) {
      onMessage("Team name is required.");
      return;
    }

    setTeamNameSaving(true);
    const res = await fetch(teamNameUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: name }),
    });
    setTeamNameSaving(false);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to update team name");
      return;
    }

    setTeamName(data.teamName || name);
    onMessage("✅ Team name updated.");
  }

  function setPositionWeight(key: string, value: number) {
    setWeights((w) => (w ? { ...w, positionWeights: { ...w.positionWeights, [key]: value } } : w));
  }

  async function saveWeights() {
    if (!weights) return;
    onMessage(null);
    setWeightsSaving(true);
    const res = await fetch(balanceWeightsUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weights }),
    });
    const data = await res.json().catch(() => ({}));
    setWeightsSaving(false);
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to save balance weights");
      return;
    }
    onMessage("✅ Balance weights saved.");
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-4">
      <div className="font-semibold">Settings</div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Team Name (shows in header)</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <input
            className="border rounded-md px-3 py-2 w-full md:col-span-2"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="New England Eagles"
          />
          <button
            className="bg-black text-white rounded-md py-2 disabled:opacity-60"
            disabled={teamNameSaving}
            onClick={saveTeamName}
          >
            {teamNameSaving ? "Saving..." : "Save Team Name"}
          </button>
        </div>
      </div>

      {weights && (
        <div className="space-y-2 pt-2 border-t">
          <div className="text-sm font-medium">Balance Weights</div>
          <div className="text-xs text-gray-500">
            playerImpact = rating×10 + stamina×2×staminaCoef + positionWeight×3
          </div>

          <div>
            <label className="block text-xs mb-1">Stamina coefficient</label>
            <input
              type="number"
              step="0.1"
              className="border rounded-md px-3 py-2 w-full max-w-xs"
              value={weights.staminaCoef}
              onChange={(e) => setWeights({ ...weights, staminaCoef: Number(e.target.value) })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {POSITIONS.map((k) => (
              <div key={k}>
                <label className="block text-xs mb-1">{k}</label>
                <input
                  type="number"
                  step="0.5"
                  className="border rounded-md px-3 py-2 w-full"
                  value={weights.positionWeights[k] ?? 1}
                  onChange={(e) => setPositionWeight(k, Number(e.target.value))}
                />
              </div>
            ))}
          </div>

          <button
            className="bg-black text-white rounded-md py-2 px-4 disabled:opacity-60"
            disabled={weightsSaving}
            onClick={saveWeights}
          >
            {weightsSaving ? "Saving…" : "Save Balance Weights"}
          </button>
        </div>
      )}
    </div>
  );
}
