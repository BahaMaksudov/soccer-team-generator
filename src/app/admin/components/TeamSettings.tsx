"use client";

import { useEffect, useState } from "react";

/**
 * Team name setting. Fully self-contained — nothing else on the Admin
 * page reads `teamName`, so it owns its own fetch/save state.
 *
 * Success/error text is reported through `onMessage`, not shown inline,
 * to preserve the exact pre-refactor behavior: it appeared in the
 * shared banner at the top of the Admin page, not inside this card.
 */
export default function TeamSettings({ onMessage }: { onMessage: (msg: string | null) => void }) {
  const [teamName, setTeamName] = useState("");
  const [teamNameSaving, setTeamNameSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/settings/team-name", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTeamName(data.teamName || "");
      }
    })();
  }, []);

  async function saveTeamName() {
    onMessage(null);
    const name = teamName.trim();
    if (!name) {
      onMessage("Team name is required.");
      return;
    }

    setTeamNameSaving(true);
    const res = await fetch("/api/admin/settings/team-name", {
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

  return (
    <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
      <div className="font-semibold">Team Settings</div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="md:col-span-2">
          <label className="block text-sm mb-1">Team Name (shows in header)</label>
          <input
            className="border rounded-md px-3 py-2 w-full"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="New England Eagles"
          />
        </div>

        <button
          className="bg-black text-white rounded-md py-2 disabled:opacity-60"
          disabled={teamNameSaving}
          onClick={saveTeamName}
        >
          {teamNameSaving ? "Saving..." : "Save Team Name"}
        </button>
      </div>

      <div className="text-xs text-gray-500">This updates instantly in Neon DB (no redeploy needed).</div>
    </div>
  );
}
