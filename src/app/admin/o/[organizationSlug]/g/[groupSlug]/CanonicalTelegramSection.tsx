"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatMDYYFromISO } from "@/lib/telegramFormat";
import {
  canCloseAndPost,
  deliveryActions,
  deliveryStatusLabel,
  describeCloseAndPostResult,
  intentForAction,
  type CloseAndPostOutcome,
  type DeliveryAction,
  type PublishedGeneration,
  type TeamsDeliveryState,
} from "@/lib/closeAndPostUi";
import { generateDateFromImportedPoll } from "@/lib/canonicalAdminState";
import type { ImportedPollResult, Player } from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6D.5B — canonical Telegram section, initially read-only.
 * Phase 2D.6D.5C — evolved into the operational canonical Telegram
 * experience: create poll, import poll (feeding the SAME
 * selected-player state CanonicalAdminWorkspace already owns for
 * Generate — no second, independent selection state), and link
 * Telegram users to Players. One linking UI only, unlike the legacy
 * app's two independent implementations (Phase 2D.6D.5A §9 finding).
 *
 * Still deliberately excludes any chat-registration control.
 *
 * Phase 2D.6D.5D — adds the explicit "Close Poll & Post Teams to
 * Telegram" action (separate from Publish). It is offered only for the
 * TeamGeneration published by the current canonical workflow
 * (`publishedGeneration`), never merely because an old poll exists,
 * and only when the selected poll's date matches. No result is ever
 * retried automatically. UX only — the server is authoritative.
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
  // Persisted TelegramPoll.pollDate only (null if the column is null).
  // The only field Close/Post eligibility may use — see canCloseAndPost.
  persistedPollDate: string | null;
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
  onImportedPoll,
  publishedGeneration,
  previewPending = false,
}: {
  /** M9-A — an unpublished preview is open in Generate: hide team posting (it always sends the published teams). */
  previewPending?: boolean;
  organizationSlug: string;
  groupSlug: string;
  players: Player[];
  /** Replaces the shared selection; applies the poll's persisted date (if any) to Generate. */
  onImportedPoll: (ids: string[], pollDate: string | null) => ImportedPollResult;
  publishedGeneration: PublishedGeneration | null;
}) {
  const chatsUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/chats" });
  const usersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/users" });
  const createPollUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/create-poll" });
  const importUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/import" });
  const linkUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/link" });
  const closeAndPostUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/close-and-post" });
  const deliveryUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/delivery" });

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
      // Phase 2D.6D.5E.3 — only the persisted pollDate may set the
      // Generate date (never question text; null → date left unchanged).
      const importedPoll = polls.find((p) => p.pollId === selectedImportPollId);
      const result = onImportedPoll(ids, generateDateFromImportedPoll(importedPoll));

      const parts = [`✅ Imported & selected ${result.selectedCount} player(s) from poll.`];
      if (result.skippedCount > 0) parts.push(`${result.skippedCount} inactive/unknown player(s) skipped.`);
      if (data.missingUserIds?.length) {
        parts.push(`Missing links for ${data.missingUserIds.length} Telegram user(s) — link them below.`);
      }
      parts.push(
        result.generateDate
          ? `Generate date set to ${result.generateDate}.`
          : "This poll has no saved date — check the Generate date."
      );
      setImportMsg(parts.join(" "));
    } finally {
      setImporting(false);
    }
  }

  // --- Close Poll & Post Teams ---
  const [closePostPollId, setClosePostPollId] = useState("");
  const [closingAndPosting, setClosingAndPosting] = useState(false);
  const [closePostResult, setClosePostResult] = useState<CloseAndPostOutcome | null>(null);

  const closePostPoll = polls.find((p) => p.pollId === closePostPollId) ?? null;

  // A newly published (or reset) generation invalidates any old result.
  useEffect(() => {
    setClosePostResult(null);
  }, [publishedGeneration]);

  // Preselect a listed poll with the published date, unless the current
  // selection already matches it.
  useEffect(() => {
    if (!publishedGeneration) return;
    setClosePostPollId((prev) => {
      const current = polls.find((p) => p.pollId === prev);
      if (current && current.persistedPollDate === publishedGeneration.date) return prev;
      const match = polls.find((p) => p.persistedPollDate === publishedGeneration.date);
      return match ? match.pollId : prev;
    });
  }, [publishedGeneration, polls]);

  const closePostEnabled = canCloseAndPost({
    poll: closePostPoll,
    publishedGeneration,
    running: closingAndPosting,
  });

  // M6-B — durable delivery status for (selected poll, published teams).
  const [delivery, setDelivery] = useState<{
    state: TeamsDeliveryState;
    deliveryId: string | null;
    visibility: "PUBLIC" | "LINK" | "PRIVATE";
  } | null>(null);
  const [shareUrl, setShareUrl] = useState("");

  async function loadDelivery() {
    if (!publishedGeneration || !closePostPoll || closePostPoll.persistedPollDate !== publishedGeneration.date) {
      setDelivery(null);
      return;
    }
    const qs = new URLSearchParams({ pollId: closePostPoll.pollId, teamGenerationId: publishedGeneration.id });
    const res = await fetch(`${deliveryUrl}?${qs.toString()}`, { cache: "no-store" }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    setDelivery(data && typeof data.state === "string" ? data : null);
  }
  useEffect(() => {
    loadDelivery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePostPoll?.pollId, closePostPoll?.persistedPollDate, publishedGeneration?.id, publishedGeneration?.date]);

  const actions = closePostEnabled ? (delivery ? deliveryActions(delivery.state) : (["post"] as DeliveryAction[])) : [];

  async function markAsSent() {
    if (!delivery?.deliveryId || closingAndPosting) return;
    setClosingAndPosting(true);
    setClosePostResult(null);
    try {
      const res = await fetch(deliveryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_sent", deliveryId: delivery.deliveryId }),
      });
      const data = await res.json().catch(() => null);
      setClosePostResult(describeCloseAndPostResult(res.ok, data));
    } catch {
      setClosePostResult({ tone: "error", message: "Could not reach the server. Nothing was changed." });
    } finally {
      setClosingAndPosting(false);
      await loadDelivery();
    }
  }

  async function closePollAndPostTeams(action: DeliveryAction = "post") {
    if (!publishedGeneration || !closePostPoll || closingAndPosting) return;
    const intent = intentForAction(action);
    if (!intent) return;
    setClosingAndPosting(true);
    setClosePostResult(null);
    try {
      const res = await fetch(closeAndPostUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pollId: closePostPoll.pollId, teamGenerationId: publishedGeneration.id,
          intent,
          ...(intent === "retry_uncertain" && delivery?.deliveryId ? { deliveryId: delivery.deliveryId } : {}),
          ...(delivery?.visibility === "LINK" && shareUrl.trim() ? { shareUrl: shareUrl.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      setClosePostResult(describeCloseAndPostResult(res.ok, data));
    } catch {
      // Network failure reaching OUR server: the server may still have
      // posted. Same guidance as any other ambiguous outcome.
      setClosePostResult({
        tone: "warning",
        message: "⚠️ Lost contact with the server. Teams may or may not have been posted — check the Telegram chat before trying again.",
      });
    } finally {
      setClosingAndPosting(false);
      await loadPolls();
      await loadDelivery();
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

      {/* Close Poll & Post Teams */}
      <div className="space-y-2 pt-2 border-t">
        <div className="text-sm font-medium">Close Poll &amp; Post Teams to Telegram</div>
        <div className="text-xs text-gray-500">
          Separate from Publish. Closes the selected poll and posts the teams you just published for the same
          date to its Telegram chat.
        </div>
        {!publishedGeneration ? (
          <div className="text-sm text-gray-500">Generate and Publish teams above first.</div>
        ) : previewPending ? (
          <div className="text-sm text-gray-500">
            An unpublished preview is open above. Telegram always posts the published teams — publish or clear the
            preview first.
          </div>
        ) : polls.length === 0 ? (
          <div className="text-sm text-gray-500">No polls available.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-2">
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={closePostPollId}
                onChange={(e) => {
                  setClosePostPollId(e.target.value);
                  setClosePostResult(null);
                }}
              >
                <option value="">Select a poll…</option>
                {polls.map((p) => (
                  <option key={p.pollId} value={p.pollId}>
                    {p.chatTitle} — {p.question || p.pollId} {p.isClosed ? "[closed]" : "[open]"}
                  </option>
                ))}
              </select>
              <div className="text-xs text-gray-500 mt-1">
                Published teams date: {publishedGeneration.date}
                {closePostPoll && !closePostPoll.persistedPollDate && (
                  <span className="text-rose-600"> — selected poll has no saved poll date and cannot be used</span>
                )}
                {closePostPoll &&
                  closePostPoll.persistedPollDate &&
                  closePostPoll.persistedPollDate !== publishedGeneration.date && (
                    <span className="text-rose-600"> — selected poll date does not match</span>
                  )}
              </div>
            </div>
            <button
              className="bg-amber-600 text-white rounded-md py-2 px-3 disabled:opacity-60"
              onClick={() => closePollAndPostTeams(actions.includes("retry_failed") ? "retry_failed" : "post")}
              disabled={!closePostEnabled || !(actions.includes("post") || actions.includes("retry_failed"))}
            >
              {closingAndPosting
                ? "Closing & posting…"
                : actions.includes("retry_failed")
                  ? "Retry: Close Poll & Post Teams"
                  : "Close Poll & Post Teams to Telegram"}
            </button>
          </div>
        )}

        {closePostEnabled && delivery && !previewPending && (
          <div className="space-y-2 text-sm">
            <div>
              Telegram status: <span className="font-medium">{deliveryStatusLabel(delivery.state)}</span>
            </div>
            {delivery.visibility === "LINK" && (actions.includes("post") || actions.includes("retry_failed") || actions.includes("post_updated") || actions.includes("retry_uncertain")) && (
              <div>
                <label className="block text-xs text-gray-600 mb-1" htmlFor="shareUrl">
                  Share link to include (optional — paste the group&apos;s current share link)
                </label>
                <input id="shareUrl" className="border rounded-md px-3 py-1.5 w-full" value={shareUrl}
                  onChange={(e) => setShareUrl(e.target.value)} placeholder="https://…/share#…" autoComplete="off" />
              </div>
            )}
            {actions.includes("post_updated") && (
              <div className="space-y-1">
                <div className="text-xs text-gray-600">This sends ANOTHER message with the updated teams to the Telegram chat.</div>
                <button type="button" className="bg-amber-600 text-white rounded-md py-1.5 px-3 disabled:opacity-60"
                  disabled={closingAndPosting} onClick={() => closePollAndPostTeams("post_updated")}>
                  Post Updated Teams
                </button>
              </div>
            )}
            {actions.includes("mark_sent") && (
              <div className="space-y-1">
                <div className="text-xs text-amber-700">
                  Delivery status uncertain. Check the Telegram chat before retrying — retrying when the teams are already
                  there posts them twice.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="border rounded-md py-1.5 px-3 disabled:opacity-60" disabled={closingAndPosting || !delivery.deliveryId} onClick={markAsSent}>
                    Mark as sent
                  </button>
                  <button type="button" className="border rounded-md py-1.5 px-3 disabled:opacity-60" disabled={closingAndPosting} onClick={() => closePollAndPostTeams("retry_uncertain")}>
                    Retry send
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {closePostResult && (
          <div
            className={
              closePostResult.tone === "success"
                ? "text-sm text-emerald-700"
                : closePostResult.tone === "warning"
                  ? "text-sm text-amber-700"
                  : "text-sm text-rose-700"
            }
          >
            {closePostResult.message}
          </div>
        )}
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
