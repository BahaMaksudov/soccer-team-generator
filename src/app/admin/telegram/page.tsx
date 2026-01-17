"use client";
import Link from "next/link";

import { useEffect, useMemo, useRef, useState } from "react";

type TgUser = { userId: string; username?: string | null; firstName?: string | null; lastName?: string | null };
type Player = { id: string; firstName?: string | null; lastName?: string | null };

function fullName(first?: string | null, last?: string | null) {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

function toYmdLocal(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

function nextMondayDate(base = new Date()) {
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
  
    const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
    const daysUntilMonday = (8 - day) % 7;
    d.setDate(d.getDate() + daysUntilMonday);
  
    return d;
  }
  
  function toYMD(d: Date) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  

export default function AdminTelegramPage() {
  const topRef = useRef<HTMLDivElement | null>(null);

  // --- data ---
  const [tgUsers, setTgUsers] = useState<TgUser[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);

  // --- messages ---
  const [msg, setMsg] = useState<string | null>(null);

  // --- Create Poll form ---
  const [chatId, setChatId] = useState("");
  const [pollDate, setPollDate] = useState(""); // YYYY-MM-DD
  const [question, setQuestion] = useState(""); // optional override
  const [isLoadingPoll, setIsLoadingPoll] = useState(false);

  //--setting polldate to next Monday
  useEffect(() => {
    setPollDate((prev) => prev || toYMD(nextMondayDate(new Date())));
  }, []);

  useEffect(() => {
    // Pre-fill poll date to next Monday on first load
    setPollDate((prev) => prev || toYmdLocal(nextMondayDate(new Date())));
  }, []);

  // --- Linking form ---
  const [linkSavingUserId, setLinkSavingUserId] = useState<string | null>(null);
  const [linkMap, setLinkMap] = useState<Record<string, string>>({}); // userId -> playerId

  async function loadAll() {
    setMsg(null);

    const [uRes, pRes] = await Promise.all([
      fetch("/api/admin/telegram/users"),
      fetch("/api/admin/players"),
    ]);

    const uData = await uRes.json();
    const pData = await pRes.json();

    setTgUsers(Array.isArray(uData?.users) ? uData.users : []);
    setPlayers(Array.isArray(pData?.players) ? pData.players : []);

    // if your users endpoint already returns link info, you can prefill here.
    // Otherwise keep it empty (you can add /api/admin/telegram/links later).
  }

    const [chats, setChats] = useState<{chatId: string; title: string}[]>([]);
    const [selectedChatId, setSelectedChatId] = useState("");

useEffect(() => {
  fetch("/api/admin/telegram/chats")
    .then((r) => r.json())
    .then((d) => setChats(Array.isArray(d?.chats) ? d.chats : []));
}, []);

useEffect(() => {
  if (!chatId && chats.length > 0) {
    setSelectedChatId(chats[0].chatId);
    setChatId(chats[0].chatId);
  }
}, [chats]);


  useEffect(() => {
    loadAll();
  }, []);

  const playerOptions = useMemo(() => {
    return players
      .map((p) => ({
        id: p.id,
        label: fullName(p.firstName, p.lastName) || `Player ${p.id}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [players]);

  async function saveLink(userId: string, playerId: string) {
    setMsg(null);
    setLinkSavingUserId(userId);

    try {
      const res = await fetch("/api/admin/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, playerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error ?? "Failed to save link");
        return;
      }
      setMsg("✅ Saved link.");
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } finally {
      setLinkSavingUserId(null);
    }
  }

  async function createPoll() {
    setMsg(null);

    if (!chatId.trim()) {
      setMsg("Chat ID is required.");
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (!pollDate) {
      setMsg("Poll date is required.");
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    setIsLoadingPoll(true);
    try {
      const res = await fetch("/api/admin/telegram/create-poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: chatId.trim(),
          pollDate,               // YYYY-MM-DD
          question: question.trim() || undefined, // optional override
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error ?? "Failed to create poll");
        topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      setMsg(`✅ Poll created. pollId=${data.pollId}`);
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

      // optional: refresh users/polls
      // await loadAll();
    } finally {
      setIsLoadingPoll(false);
    }
  }

  return (
    <div className="space-y-6">
      <div ref={topRef} />

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Telegram Admin</h1>
        <button className="border rounded-md px-3 py-2 text-sm bg-white" onClick={loadAll}>
          Refresh
        </button>

        <Link className="ml-auto text-sm underline" href="/admin">
         Back to Admin
        </Link>

      </div>

      {msg && (
        <div className="border rounded-lg p-3 bg-white text-sm">
          {msg}
        </div>
      )}

      {/* Create Poll */}
      <div className="border rounded-xl p-4 bg-white space-y-3">
        <div className="font-semibold">Create Telegram Poll (from website)</div>
        <div className="text-xs text-gray-500">
          This will send a poll to the Telegram group (chat) using the bot token.
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>

          <label className="block text-sm mb-1">Telegram Group</label>
<select
  className="border rounded-md px-3 py-2 w-full bg-white"
  value={selectedChatId}
  onChange={(e) => {
    const v = e.target.value;
    setSelectedChatId(v);
    setChatId(v);
  }}
>
  {chats.map((c) => (
    <option key={c.chatId} value={c.chatId}>
      {c.title ? `${c.title} (${c.chatId})` : c.chatId}
    </option>
  ))}
</select>

<div className="text-xs text-gray-500 mt-1">
  Don’t see your group? Type <code>/chatid</code> in the group once (bot must be in the group).
</div>
            {/* <label className="block text-sm mb-1">Chat ID</label>
            <input
              className="border rounded-md px-3 py-2 w-full"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. -1001234567890"
            />
            <div className="text-xs text-gray-500 mt-1">
              Tip: for groups it usually starts with <code>-100...</code>
            </div> */}
          </div>

          <div>
            <label className="block text-sm mb-1">Poll date</label>
            <input
              type="date"
              className="border rounded-md px-3 py-2 w-full"
              value={pollDate}
              onChange={(e) => setPollDate(e.target.value)}
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-sm mb-1">Question override (optional)</label>
            <input
              className="border rounded-md px-3 py-2 w-full"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder='Leave blank to auto-generate: "Who is playing on 1/19/26?"'
            />
          </div>
        </div>

        <button
          className="bg-indigo-600 text-white rounded-md py-2 px-4 disabled:opacity-60"
          disabled={isLoadingPoll}
          onClick={createPoll}
        >
          {isLoadingPoll ? "Creating..." : "Create Poll"}
        </button>
      </div>

      {/* Link Telegram Users */}
      <div className="border rounded-xl p-4 bg-white space-y-3">
        <div className="font-semibold">Link Telegram Users → Players</div>
        <div className="text-xs text-gray-500">
          One-time mapping. Usernames can be empty — mapping uses <code>userId</code>.
        </div>

        {tgUsers.length === 0 ? (
          <div className="text-sm text-gray-600">No Telegram users found yet (no votes received).</div>
        ) : (
          <div className="space-y-3">
            {tgUsers.map((u) => {
              const label =
                u.username?.trim()
                  ? `@${u.username}`
                  : fullName(u.firstName, u.lastName) || `User ${u.userId}`;

              const selected = linkMap[u.userId] ?? "";

              return (
                <div key={u.userId} className="flex items-center gap-3">
                  <div className="w-52 text-sm font-medium">{label}</div>

                  <select
                    className="border rounded-md px-3 py-2 flex-1 bg-white"
                    value={selected}
                    onChange={(e) => {
                      const v = e.target.value;
                      setLinkMap((m) => ({ ...m, [u.userId]: v }));
                    }}
                  >
                    <option value="">Select a player...</option>
                    {playerOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>

                  <button
                    className="border rounded-md px-3 py-2 text-sm bg-white disabled:opacity-60"
                    disabled={!selected || linkSavingUserId === u.userId}
                    onClick={() => saveLink(u.userId, selected)}
                  >
                    {linkSavingUserId === u.userId ? "Saving..." : "Save"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
