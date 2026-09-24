"use client";

import { useEffect, useMemo, useState } from "react";
import { positionLabel } from "@/lib/labels";

/**
 * Phase 2D.5C — canonical, Group-aware Players client.
 *
 * Deliberately a separate component from the legacy
 * src/app/players/players-client.tsx (Phase 2D.5B precedent, report
 * §M): changing the legacy component in place risks altering the
 * still-live, unscoped `/players` page it powers. Rendering/behavior
 * here intentionally matches the legacy UI exactly (name, position,
 * status columns; sorted by full name) — the only difference is the
 * data source: this component receives organizationSlug/groupSlug
 * (never a groupId) and calls the canonical, tenant-scoped API. The
 * server resolves those slugs independently on every request; the
 * browser never asserts ownership.
 */

type Position = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: Position;
  isActive: boolean;
};

export default function CanonicalPlayersClient({
  organizationSlug,
  groupSlug,
}: {
  organizationSlug: string;
  groupSlug: string;
}) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/${organizationSlug}/${groupSlug}/players`, {
          cache: "no-store",
        });
        const data = await res.json();
        setPlayers(Array.isArray(data) ? data : []);
      } finally {
        setLoading(false);
      }
    })();
  }, [organizationSlug, groupSlug]);

  // Sort by name only (A → Z) — matches legacy behavior
  const rows = useMemo(() => {
    return players
      .map((p) => ({
        ...p,
        fullName: `${p.firstName} ${p.lastName}`.trim(),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
  }, [players]);

  return (
    <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
      <div className="sticky top-0 z-30 bg-white border-b">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">All Players</h1>
              <p className="text-xs text-slate-600">View-only list of registered players</p>
            </div>
            <div className="text-sm text-slate-600">Showing {rows.length} player(s)</div>
          </div>
        </div>
      </div>

      <div className="p-5">
        <div className="border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="bg-slate-900 text-white">
                <tr>
                  <th className="p-3 text-left">Name</th>
                  <th className="p-3 text-left">Position</th>
                  <th className="p-3 text-left">Status</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-slate-50">
                    <td className="p-3">{p.fullName}</td>
                    <td className="p-3">{positionLabel(p.position)}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-1 rounded-full text-xs border ${
                          p.isActive
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-slate-50 text-slate-600 border-slate-200"
                        }`}
                      >
                        {p.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-4 text-slate-600">
                      No players found
                    </td>
                  </tr>
                )}

                {loading && (
                  <tr>
                    <td colSpan={3} className="p-4 text-slate-600">
                      Loading...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
