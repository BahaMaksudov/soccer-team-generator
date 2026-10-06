"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import type { Player } from "../CanonicalAdminWorkspace";

/**
 * UI-8 — "Link Telegram users → players" (OWNER/ADMIN), moved from the
 * Overview's legacy Telegram section unchanged in behavior: lists this
 * Group's unlinked Telegram voters (/telegram/users) and links one to a
 * Player (/telegram/link). Identity configuration only — it never sends
 * anything to Telegram. Every fetch is tenant-bound via adminTenantApiPath.
 */
type TelegramUserItem = {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

function displayName(u: TelegramUserItem) {
  return (u.username ? `@${u.username}` : null) || [u.firstName, u.lastName].filter(Boolean).join(" ") || `userId ${u.userId}`;
}

export default function TelegramVoterLinks({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const usersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/users" });
  const linkUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/link" });
  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });

  const [users, setUsers] = useState<TelegramUserItem[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [linkSelection, setLinkSelection] = useState<Record<string, string>>({});
  const [linkingUserId, setLinkingUserId] = useState<string | null>(null);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  async function loadUsers() {
    const res = await fetch(usersUrl, { cache: "no-store" });
    if (res.ok) setUsers(await res.json());
  }

  useEffect(() => {
    loadUsers();
    (async () => {
      const res = await fetch(playersUrl, { cache: "no-store" });
      if (res.ok) setPlayers(await res.json());
    })();
    // Intentional: only re-fetch when the tenant identity itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  const playerOptions = useMemo(() => [...players].sort((a, b) => Number(b.isActive) - Number(a.isActive)), [players]);

  async function linkUser(userId: string) {
    const playerId = linkSelection[userId];
    if (!playerId) {
      setLinkMsg("Pick a player for that Telegram user first.");
      return;
    }
    setLinkingUserId(userId);
    setLinkMsg(null);
    try {
      const res = await fetch(linkUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, playerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLinkMsg(data?.error ?? "Failed to link Telegram user");
        return;
      }
      setLinkMsg("✅ Linked.");
      await loadUsers();
    } finally {
      setLinkingUserId(null);
    }
  }

  return (
    <div className="mt-4 space-y-2 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Link Telegram users → players</h3>
        <button type="button" className="text-xs underline" onClick={loadUsers}>
          Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Telegram poll voters who aren&apos;t linked to a player yet. Linking never sends anything to Telegram.</p>
      {linkMsg && <div className="text-sm text-blue-700">{linkMsg}</div>}

      {users.length === 0 ? (
        <div className="text-sm text-gray-500">No unlinked voters for this Group.</div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div key={u.userId} className="flex flex-col gap-2 rounded-lg border p-2 md:flex-row md:items-center">
              <div className="min-w-0 break-words text-sm font-medium md:w-56">{displayName(u)}</div>
              <select
                aria-label={`Player for ${displayName(u)}`}
                className="w-full min-w-0 rounded-md border px-3 py-2 text-sm md:flex-1"
                value={linkSelection[u.userId] ?? ""}
                onChange={(e) => setLinkSelection((prev) => ({ ...prev, [u.userId]: e.target.value }))}
              >
                <option value="">Select a player…</option>
                {playerOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName} {p.isActive ? "" : "(inactive)"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-60"
                onClick={() => linkUser(u.userId)}
                disabled={linkingUserId === u.userId}
              >
                {linkingUserId === u.userId ? "Linking…" : "Link"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
