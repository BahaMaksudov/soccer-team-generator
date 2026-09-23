"use client";

import { useEffect, useMemo, useState } from "react";
import type { Player, TelegramUser } from "../types";

/**
 * "Link Telegram Users → Players". Fully self-contained: owns its own
 * Telegram-users list, busy/message state, and the userId->playerId
 * mapping. `players` is the one thing it needs from the page (to
 * populate the dropdown) — it never mutates it.
 */
export default function TelegramUserLinks({ players }: { players: Player[] }) {
  const [telegramUsers, setTelegramUsers] = useState<TelegramUser[]>([]);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  const [linkSelection, setLinkSelection] = useState<Record<string, string>>({}); // userId -> playerId

  async function loadTelegramUsers() {
    setTgMsg(null);
    const res = await fetch("/api/admin/telegram/users", { cache: "no-store" });
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      setTgMsg(data?.error ?? "Failed to load Telegram users");
      return;
    }
    setTelegramUsers(Array.isArray(data) ? data : []);
  }

  useEffect(() => {
    loadTelegramUsers();
  }, []);

  async function linkTelegramUser(userId: string) {
    const playerId = linkSelection[userId];
    if (!playerId) {
      setTgMsg("Pick a player for that Telegram user first.");
      return;
    }

    setTgBusy(true);
    setTgMsg(null);
    try {
      const res = await fetch("/api/admin/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, playerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTgMsg(data?.error ?? "Failed to link Telegram user");
        return;
      }
      setTgMsg("✅ Linked.");
      await loadTelegramUsers(); // will remove linked user from list
    } finally {
      setTgBusy(false);
    }
  }

  const playerOptions = useMemo(() => {
    // show active players first
    const sorted = [...players].sort((a, b) => Number(b.isActive) - Number(a.isActive));
    return sorted;
  }, [players]);

  return (
    <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
      <div className="flex items-center">
        <div className="font-semibold">Link Telegram Users → Players</div>
        <button
          className="ml-auto text-sm underline"
          onClick={() => loadTelegramUsers()}
          disabled={tgBusy}
          title="Refresh Telegram users list"
        >
          Refresh
        </button>
      </div>

      <div className="text-xs text-gray-500">
        One-time mapping. Telegram usernames can be empty — mapping uses <b>userId</b> which is stable.
      </div>

      {tgMsg && <div className="text-sm text-blue-700">{tgMsg}</div>}

      {telegramUsers.length === 0 ? (
        <div className="text-sm text-gray-600">
          No unlinked Telegram users found yet. Ask people to vote once.
        </div>
      ) : (
        <div className="space-y-3">
          {telegramUsers.map((u) => {
            const label =
              (u.username ? `@${u.username}` : null) ||
              [u.firstName, u.lastName].filter(Boolean).join(" ") ||
              `userId ${u.userId}`;

            return (
              <div key={u.userId} className="border rounded-lg p-3 flex flex-col md:flex-row md:items-center gap-3">
                <div className="text-sm font-medium md:w-64">{label}</div>

                <select
                  className="border rounded-md px-3 py-2 w-full md:flex-1"
                  value={linkSelection[u.userId] ?? ""}
                  onChange={(e) =>
                    setLinkSelection((prev) => ({
                      ...prev,
                      [u.userId]: e.target.value,
                    }))
                  }
                >
                  <option value="">Select a player…</option>
                  {playerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.firstName} {p.lastName} {p.isActive ? "" : "(inactive)"}
                    </option>
                  ))}
                </select>

                <button
                  className="bg-black text-white rounded-md px-4 py-2 disabled:opacity-60"
                  onClick={() => linkTelegramUser(u.userId)}
                  disabled={tgBusy}
                >
                  Link
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
