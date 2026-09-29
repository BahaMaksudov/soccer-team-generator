"use client";

import { useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";

/**
 * Phase 2D.6D.5B — canonical, deliberately READ-ONLY Telegram section.
 * Displays registered chats, polls, and unlinked voters for the
 * URL-resolved Group. Every fetch is built via adminTenantApiPath(...)
 * — never a flat /api/admin/telegram/* URL, never a DB id.
 *
 * No poll-creation, import, linking, closing, or team-posting controls
 * exist here on purpose (Phase 2D.6D.5A §12 decomposition) — those
 * arrive in later 2D.6D.5 subphases. This component issues GET
 * requests only; it never calls the Telegram Bot API.
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

export default function CanonicalTelegramSection({
  organizationSlug,
  groupSlug,
}: {
  organizationSlug: string;
  groupSlug: string;
}) {
  const chatsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/chats" });
  const pollsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/polls?includeClosed=1" });
  const usersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/users" });

  const [chats, setChats] = useState<TelegramChatItem[]>([]);
  const [polls, setPolls] = useState<TelegramPollItem[]>([]);
  const [users, setUsers] = useState<TelegramUserItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      const [chatsRes, pollsRes, usersRes] = await Promise.all([
        fetch(chatsUrl, { cache: "no-store" }),
        fetch(pollsUrl, { cache: "no-store" }),
        fetch(usersUrl, { cache: "no-store" }),
      ]);
      if (cancelled) return;

      if (chatsRes.ok) {
        const data = await chatsRes.json();
        setChats(data.chats ?? []);
      }
      if (pollsRes.ok) {
        const data = await pollsRes.json();
        setPolls(data.polls ?? []);
      }
      if (usersRes.ok) {
        setUsers(await usersRes.json());
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching every other canonical component's own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  function displayName(u: TelegramUserItem) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return name || (u.username ? `@${u.username}` : `User ${u.userId}`);
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-4">
      <div className="font-semibold">Telegram (read-only)</div>
      {loading && <div className="text-sm text-gray-500">Loading…</div>}

      <div className="space-y-2">
        <div className="text-sm font-medium">Registered Chats</div>
        {chats.length === 0 ? (
          <div className="text-sm text-gray-500">No chats registered for this Group.</div>
        ) : (
          <ul className="text-sm space-y-1">
            {chats.map((c) => (
              <li key={c.chatId}>
                {c.title || "Untitled chat"} <span className="text-gray-400">({c.chatId})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 pt-2 border-t">
        <div className="text-sm font-medium">Polls</div>
        {polls.length === 0 ? (
          <div className="text-sm text-gray-500">No polls for this Group.</div>
        ) : (
          <ul className="text-sm space-y-1">
            {polls.map((p) => (
              <li key={p.pollId}>
                {p.question || "(no question)"} — {p.chatTitle} —{" "}
                {p.isClosed ? "closed" : "open"}
                {p.pollDateStr ? ` — ${p.pollDateStr}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 pt-2 border-t">
        <div className="text-sm font-medium">Unlinked Telegram Voters</div>
        {users.length === 0 ? (
          <div className="text-sm text-gray-500">No unlinked voters for this Group.</div>
        ) : (
          <ul className="text-sm space-y-1">
            {users.map((u) => (
              <li key={u.userId}>{displayName(u)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
