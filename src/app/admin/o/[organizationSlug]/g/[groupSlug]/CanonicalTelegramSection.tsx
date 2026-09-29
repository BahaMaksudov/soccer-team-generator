"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatMDYYFromISO } from "@/lib/telegramFormat";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6D.5B — canonical Telegram section, initially read-only.
 * Phase 2D.6D.5C — evolved into the operational canonical Telegram
 * experience: create poll, import poll (feeding the SAME
 * selected-player state CanonicalAdminWorkspace already owns for
 * Generate — no second, independent selection state), and link
 * Telegram users to Players. One linking UI only, unlike the legacy
 * app's two independent implementations (Phase 2D.6D.5A §9 finding).
 *
 * Still deliberately excludes: close-poll, post-teams-to-Telegram, and
 * any chat-registration control — those remain out of scope for D.5C
 * (Phase 2D.6D.5A §12 decomposition; close/post is D.5D).
 *
 * Every fetch is built via adminTenantApiPath(...) — never a flat
 * /api/admin/telegram/* URL, never a DB id.
 */

type TelegramChatItem = {
  chatId: string;
  title: string;
};

type TelegramPollItem = {
  pollId: string;
  chatId: string;
  chatTitle: string;
  question: string;
  isClosed: boolean;
  createdAt: string | null;
  pollDate: string | null;
  pollDateStr: string | null;
};

type TelegramUserItem = {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

function nextMondayYMD(base = new Date()) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const daysUntilMonday = (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function CanonicalTelegramSection({
  organizationSlug,
  groupSlug,
  players,
  onImportedPlayerIds,
}: {
  organizationSlug: string;
  groupSlug: string;
  players: Player[];
  onImportedPlayerIds: (ids: string[]) => void;
}) {
  const chatsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/chats" });
  const usersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/users" });
  const createPollUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/create-poll" });
  const importUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/import" });
  const linkUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/link" });

  function pollsUrl(includeClosed: boolean) {
    return adminTenantApiPath({
      organizationSlug,
      groupSlug,
      path: includeClosed ? "/telegram/polls?includeClosed=1" : "/telegram/polls",
    });
  }

  const [chats, setChats] = useState<TelegramChatItem[]>([]);
  const [polls, setPolls] = useState<TelegramPollItem[]>([]);
  const [users, setUsers] = useState<TelegramUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showClosedPolls, setShowClosedPolls] = useState(false);

  async function loadChats() {
    const res = await fetch(chatsUrl, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setChats(data.chats ?? []);
    }
  }

  async function loadPolls(includeClosed = showClosedPolls) {
    const res = await fetch(pollsUrl(includeClosed), { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setPolls(data.polls ?? []);
    }
  }

  async function loadUsers() {
    const res = await fetch(usersUrl, { cache: "no-store" });
    if (res.ok) {
      setUsers(await res.json());
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadChats(), loadPolls(false), loadUsers()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching every other canonical component's own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  // --- Create Poll ---
  const [selectedChatId, setSelectedChatId] = useState("");
  const [pollDate, setPollDate] = useState(() => nextMondayYMD());
  const [question, setQuestion] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedChatId && chats.length > 0) {
      setSelectedChatId(chats[0].chatId);
    }
  }, [chats, selectedChatId]);

  const questionPlaceholder = useMemo(() => {
    const formatted = pollDate ? formatMDYYFromISO(pollDate) : "";
    return formatted
      ? `Leave blank to auto-generate: "Who is playing on ${formatted}?"`
      : "Leave blank to auto-generate the question from the poll date.";
  }, [pollDate]);

  async function createPoll() {
    setCreateMsg(null);
    if (!selectedChatId) {
      setCreateMsg("Select a registered chat first.");
      return;
    }
    if (!pollDate) {
      setCreateMsg("Poll date is required.");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch(createPollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: selectedChatId, pollDate, question: question.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateMsg(data?.error ?? "Failed to create poll");
        return;
      }
      setQuestion("");
      setCreateMsg("✅ Poll created.");
      await loadPolls();
    } finally {
      setCreating(false);
    }
  }

  // --- Import Poll ---
  const [selectedImportPollId, setSelectedImportPollId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedImportPollId && polls.length > 0) {
      setSelectedImportPollId(polls[0].pollId);
    }
  }, [polls, selectedImportPollId]);

  async function importPoll() {
    setImportMsg(null);
    if (!selectedImportPollId) {
      setImportMsg("Select a poll first.");
      return;
    }

    setImporting(true);
    try {
      const res = await fetch(importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: selectedImportPollId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportMsg(data?.error ?? "Failed to import from Telegram poll");
        return;
      }

      const ids: string[] = Array.isArray(data.selectedPlayerIds) ? data.selectedPlayerIds : [];
      onImportedPlayerIds(ids);

      if (data.missingUserIds?.length) {
        setImportMsg(
          `✅ Imported ${ids.length} player(s). Missing links for ${data.missingUserIds.length} Telegram user(s) — link them below.`
        );
      } else {
        setImportMsg(`✅ Imported & selected ${ids.length} player(s) from poll.`);
      }
    } finally {
      setImporting(false);
    }
  }

  // --- Link Users ---
  const [linkSelection, setLinkSelection] = useState<Record<string, string>>({});
  const [linkingUserId, setLinkingUserId] = useState<string | null>(null);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  const playerOptions = useMemo(
    () => [...players].sort((a, b) => Number(b.isActive) - Number(a.isActive)),
    [players]
  );

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

  function displayName(u: TelegramUserItem) {
    return (
      (u.username ? `@${u.username}` : null) ||
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      `userId ${u.userId}`
    );
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-4">
      <div className="font-semibold">Telegram</div>
      {loading && <div className="text-sm text-gray-500">Loading…</div>}

      {/* Create Poll */}
      <div className="space-y-2 pt-2 border-t">
        <div className="text-sm font-medium">Create Poll</div>
        {chats.length === 0 ? (
          <div className="text-sm text-gray-500">
            No registered Telegram chats available for this Group.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs mb-1">Chat</label>
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={selectedChatId}
                onChange={(e) => setSelectedChatId(e.target.value)}
              >
                {chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.title || `Chat ${c.chatId}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs mb-1">Poll date</label>
              <input
                type="date"
                className="border rounded-md px-3 py-2 w-full"
                value={pollDate}
                onChange={(e) => setPollDate(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs mb-1">Question (optional)</label>
              <input
                className="border rounded-md px-3 py-2 w-full"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={questionPlaceholder}
              />
            </div>
            <button
              className="bg-black text-white rounded-md py-2 px-4 disabled:opacity-60 md:col-span-1"
              disabled={creating}
              onClick={createPoll}
            >
              {creating ? "Creating…" : "Create Poll"}
            </button>
          </div>
        )}
        {createMsg && <div className="text-sm text-blue-700">{createMsg}</div>}
      </div>

      {/* Import Poll */}
      <div className="space-y-2 pt-2 border-t">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Import from Telegram Poll</div>
          <label className="text-xs text-gray-500 flex items-center gap-1">
            <input
              type="checkbox"
              checked={showClosedPolls}
              onChange={(e) => {
                setShowClosedPolls(e.target.checked);
                loadPolls(e.target.checked);
              }}
            />
            Show closed polls
          </label>
        </div>
        <div className="text-xs text-gray-500">
          Selects all players who voted ✅ Playing. Replaces the current player selection below.
        </div>

        {polls.length === 0 ? (
          <div className="text-sm text-gray-500">No polls available to import.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-2">
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={selectedImportPollId}
                onChange={(e) => setSelectedImportPollId(e.target.value)}
              >
                {polls.map((p) => (
                  <option key={p.pollId} value={p.pollId}>
                    {p.chatTitle} — {p.question || p.pollId} {p.isClosed ? "[closed]" : "[open]"}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="bg-indigo-600 text-white rounded-md py-2 disabled:opacity-60"
              onClick={importPoll}
              disabled={!selectedImportPollId || importing}
            >
              {importing ? "Importing…" : "Import Players"}
            </button>
          </div>
        )}
        {importMsg && <div className="text-sm text-blue-700">{importMsg}</div>}
      </div>

      {/* Link Users */}
      <div className="space-y-2 pt-2 border-t">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Link Telegram Users → Players</div>
          <button className="text-xs underline" onClick={loadUsers}>
            Refresh
          </button>
        </div>
        {linkMsg && <div className="text-sm text-blue-700">{linkMsg}</div>}

        {users.length === 0 ? (
          <div className="text-sm text-gray-500">No unlinked voters for this Group.</div>
        ) : (
          <div className="space-y-2">
            {users.map((u) => (
              <div key={u.userId} className="border rounded-lg p-2 flex flex-col md:flex-row md:items-center gap-2">
                <div className="text-sm font-medium md:w-56">{displayName(u)}</div>
                <select
                  className="border rounded-md px-3 py-2 w-full md:flex-1 text-sm"
                  value={linkSelection[u.userId] ?? ""}
                  onChange={(e) =>
                    setLinkSelection((prev) => ({ ...prev, [u.userId]: e.target.value }))
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
                  className="bg-black text-white rounded-md px-4 py-2 text-sm disabled:opacity-60"
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
    </div>
  );
}
