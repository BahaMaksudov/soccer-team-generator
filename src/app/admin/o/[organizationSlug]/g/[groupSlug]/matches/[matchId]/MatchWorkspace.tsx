"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { PublishedGeneration } from "@/lib/closeAndPostUi";
import type { SportClientView } from "@/lib/sports";
import CanonicalGenerateSection from "../../CanonicalGenerateSection";
import type { Player } from "../../CanonicalAdminWorkspace";
import { computeSelection, NO_ADJUSTMENTS, reconcileAdjustments, toggleSelection, type EffectiveStatuses, type SelectionAdjustments } from "@/lib/matchSelection";

/**
 * M9-A — the organizer's Match workspace. Sections, not a wizard:
 *   Match         edit date/time/location/status (saves only)
 *   Attendance    counts, roster with effective status, organizer overrides,
 *                 open/close, explicit Telegram sync, Post poll (OWNER/ADMIN)
 *   Teams         PLAYING preselected (MAYBE visible, not selected), the
 *                 existing Generate/Balance/Apply Swap/Publish, then a
 *                 separate "Post Teams to Telegram" (OWNER/ADMIN)
 * Nothing here sends unless the organizer clicks a "Post …" button.
 */

type Status = "PLAYING" | "NOT_PLAYING" | "MAYBE";
type RosterPlayer = Player & {
  attendance: { status: Status | null; source: "WEB" | "TELEGRAM" | "OVERRIDE" | null; overridden: boolean; late: boolean; participantStatus: Status | null; participantSource: "WEB" | "TELEGRAM" | null };
};
type MatchView = {
  match: { id: string; date: string; startTime: string | null; locationName: string | null; status: "SCHEDULED" | "COMPLETED" | "CANCELED"; attendanceClosed: boolean };
  canManage: boolean;
  roster: RosterPlayer[];
  counts: { PLAYING: number; MAYBE: number; NOT_PLAYING: number; NO_RESPONSE: number };
  defaultSelection: string[];
  generation: { id: string; date: string } | null;
  telegram: { connected: boolean; poll: { pollId: string | null; closed: boolean; postedAt: string } | null; unlinkedVoters: number; pollDelivery: { status: string; sentAt: string | null } | null };
};

const STATUS_LABEL: Record<Status, string> = { PLAYING: "Playing", MAYBE: "Maybe", NOT_PLAYING: "Not playing" };
const SOURCE_LABEL = { WEB: "web", TELEGRAM: "Telegram", OVERRIDE: "organizer override" } as const;

export default function MatchWorkspace({
  organizationSlug,
  groupSlug,
  matchId,
  sport,
}: {
  organizationSlug: string;
  groupSlug: string;
  matchId: string;
  sport: SportClientView;
}) {
  const api = useCallback((path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}${path}` }), [organizationSlug, groupSlug, matchId]);
  const [view, setView] = useState<MatchView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Selection = attendance-derived default (server: effective PLAYING) ± the
  // organizer's explicit adjustments (src/lib/matchSelection.ts). Re-derived on
  // every refresh, so attendance changes are always reflected.
  const [adjustments, setAdjustments] = useState<SelectionAdjustments>(NO_ADJUSTMENTS);
  const lastStatuses = useRef<EffectiveStatuses | null>(null);
  const [published, setPublished] = useState<PublishedGeneration | null>(null);
  const [chats, setChats] = useState<Array<{ ref: number; title: string }>>([]);
  const [chatRef, setChatRef] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ date: string; startTime: string; locationName: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(api(""), { cache: "no-store" });
    if (res.status === 404) return setNotFound(true);
    if (!res.ok) return;
    const data: MatchView = await res.json();
    const statuses: EffectiveStatuses = Object.fromEntries(data.roster.map((p) => [p.id, p.attendance.status]));
    setAdjustments((adj) => reconcileAdjustments(lastStatuses.current, statuses, adj));
    lastStatuses.current = statuses;
    setView(data);
    if (data.generation) setPublished({ id: data.generation.id, date: data.generation.date });
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!view?.canManage) return;
    (async () => {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/channels/telegram" }), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setChats(data.telegram ?? []);
      setChatRef((r) => r ?? data.telegram?.[0]?.ref ?? null);
    })();
  }, [view?.canManage, organizationSlug, groupSlug]);

  async function call(path: string, body: unknown, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? (data.state === "already_posted" ? "Already posted — nothing was sent again." : ok) : data?.error ?? "Something went wrong.");
      await load();
      return { ok: res.ok, data };
    } finally {
      setBusy(false);
    }
  }

  async function saveMatch(patch: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api(""), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? ok : data?.error ?? "Could not save the match.");
      if (res.ok) setEdit(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function postTeams(intent: "post" | "post_updated" = "post") {
    if (!view?.telegram.poll?.pollId || !published) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/close-and-post" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: view.telegram.poll.pollId, teamGenerationId: published.id, intent }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? "Teams posted to Telegram." : data?.error ?? "Could not post the teams.");
    } finally {
      setBusy(false);
    }
  }

  const players = useMemo(() => (view?.roster ?? []).map(({ attendance: _a, ...p }) => p as Player), [view]);
  const defaultIds = useMemo(() => view?.defaultSelection ?? [], [view]);
  const selectedIds = useMemo(() => computeSelection(defaultIds, adjustments), [defaultIds, adjustments]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (notFound) return <div className="text-sm text-gray-600">Match not found.</div>;
  if (!view) return <div className="text-sm text-gray-500">Loading…</div>;
  const m = view.match;

  return (
    <div className="space-y-4">
      {message && <div className="text-sm text-blue-700">{message}</div>}

      {/* Match */}
      <section className="border rounded-xl p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-lg font-semibold">
              {formatLongDateOnly(m.date)}
              {m.startTime ? ` · ${formatStartTime(m.startTime)}` : ""}
            </div>
            {m.locationName && <div className="text-sm text-gray-600">{m.locationName}</div>}
            {m.status !== "SCHEDULED" && <div className="text-xs mt-1">{m.status === "CANCELED" ? "Canceled" : "Completed"}</div>}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" className="underline" onClick={() => setEdit({ date: m.date, startTime: m.startTime ?? "", locationName: m.locationName ?? "" })}>Edit</button>
            {m.status === "SCHEDULED" ? (
              <>
                <button type="button" className="underline" disabled={busy} onClick={() => saveMatch({ status: "COMPLETED" }, "Marked as completed.")}>Mark completed</button>
                <button type="button" className="underline text-rose-700" disabled={busy} onClick={() => saveMatch({ status: "CANCELED" }, "Match canceled. Nothing was sent.")}>Cancel match</button>
              </>
            ) : (
              <button type="button" className="underline" disabled={busy} onClick={() => saveMatch({ status: "SCHEDULED" }, "Match reopened.")}>Reopen</button>
            )}
          </div>
        </div>
        {edit && (
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <input type="date" className="border rounded px-2 py-1" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
            <input type="time" className="border rounded px-2 py-1" value={edit.startTime} onChange={(e) => setEdit({ ...edit, startTime: e.target.value })} />
            <input className="border rounded px-2 py-1" maxLength={80} placeholder="Location" value={edit.locationName} onChange={(e) => setEdit({ ...edit, locationName: e.target.value })} />
            <button type="button" className="bg-black text-white rounded px-3 py-1" disabled={busy} onClick={() => saveMatch(edit, "Match saved. Nothing was sent.")}>Save</button>
            <button type="button" className="underline" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        )}
      </section>

      {/* Attendance */}
      <section className="border rounded-xl p-4 space-y-3">
        <div className="font-semibold">Attendance</div>
        <div className="flex flex-wrap gap-3 text-sm">
          <span><b>{view.counts.PLAYING}</b> Playing</span>
          <span><b>{view.counts.MAYBE}</b> Maybe</span>
          <span><b>{view.counts.NOT_PLAYING}</b> Not playing</span>
          <span><b>{view.counts.NO_RESPONSE}</b> No response</span>
          {m.attendanceClosed && <span className="text-xs border rounded-full px-2">Attendance closed</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => call("/attendance/close", { closed: !m.attendanceClosed }, m.attendanceClosed ? "Attendance reopened." : "Attendance closed.")}>
            {m.attendanceClosed ? "Reopen attendance" : "Close attendance"}
          </button>
          {view.telegram.poll && (
            <button type="button" className="border rounded px-3 py-1" disabled={busy} onClick={() => call("/attendance/sync", {}, "Telegram attendance synced.")}>
              Sync Telegram attendance
            </button>
          )}
          {view.canManage &&
            (view.telegram.connected && chats.length > 0 ? (
              <>
                {chats.length > 1 && (
                  <select className="border rounded px-2 py-1" value={chatRef ?? ""} onChange={(e) => setChatRef(Number(e.target.value))}>
                    {chats.map((c) => (
                      <option key={c.ref} value={c.ref}>{c.title}</option>
                    ))}
                  </select>
                )}
                <button type="button" className="bg-sky-600 text-white rounded px-3 py-1 disabled:opacity-60" disabled={busy || chatRef === null || m.status === "CANCELED"} onClick={() => call("/poll", { chatRef, intent: "post" }, "Attendance poll posted to Telegram.")}>
                  Post poll to Telegram
                </button>
              </>
            ) : (
              <span className="text-gray-600">Telegram not connected — connect it in Communication Channels on the group page.</span>
            ))}
        </div>
        {view.canManage && view.telegram.pollDelivery && <div className="text-xs text-gray-500">Last poll post: {view.telegram.pollDelivery.status.toLowerCase()}</div>}
        {view.telegram.unlinkedVoters > 0 && (
          <div className="text-xs text-amber-700">
            {view.telegram.unlinkedVoters} Telegram voter(s) aren&apos;t linked to players{view.canManage ? " — link them in the Telegram section of the group page." : "."}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1">Player</th>
                <th>Status</th>
                <th>Set by organizer</th>
              </tr>
            </thead>
            <tbody>
              {view.roster.filter((p) => p.isActive).map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-1">{p.firstName} {p.lastName}</td>
                  <td>
                    {p.attendance.status ? STATUS_LABEL[p.attendance.status] : <span className="text-gray-400">No response</span>}
                    {p.attendance.source && <span className="text-xs text-gray-500"> · {SOURCE_LABEL[p.attendance.source]}</span>}
                    {p.attendance.late && <span className="text-xs text-amber-700"> · late</span>}
                    {p.attendance.overridden && p.attendance.participantStatus && (
                      <span className="text-xs text-gray-500"> (player said {STATUS_LABEL[p.attendance.participantStatus]})</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {(["PLAYING", "MAYBE", "NOT_PLAYING"] as Status[]).map((s) => (
                      <button key={s} type="button" disabled={busy} className="underline mr-2" onClick={() => call("/attendance", { playerId: p.id, status: s }, "Attendance saved.")}>
                        {STATUS_LABEL[s]}
                      </button>
                    ))}
                    {p.attendance.overridden && (
                      <button type="button" disabled={busy} className="underline text-rose-700" onClick={() => call("/attendance", { playerId: p.id, status: null }, "Override cleared.")}>
                        Clear override
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Teams */}
      <section className="border rounded-xl p-4 space-y-3">
        <div className="font-semibold">Teams</div>
        <div className="text-xs text-gray-500">Players marked Playing are selected. Maybe players are shown but not selected — add them if you want.</div>
        <div className="flex flex-wrap gap-2 text-sm">
          {view.roster.filter((p) => p.isActive).map((p) => (
            <label key={p.id} className={`border rounded-full px-2 py-0.5 flex items-center gap-1 ${p.attendance.status === "MAYBE" ? "border-amber-300" : ""}`}>
              <input type="checkbox" checked={selectedSet.has(p.id)} onChange={() => setAdjustments((adj) => toggleSelection(defaultIds, adj, p.id))} />
              {p.firstName} {p.lastName}
              {p.attendance.status === "MAYBE" && <span className="text-xs text-amber-700">maybe</span>}
            </label>
          ))}
        </div>
        <CanonicalGenerateSection
          organizationSlug={organizationSlug}
          groupSlug={groupSlug}
          selectedIds={selectedIds}
          players={players}
          sport={sport}
          date={m.date}
          onDateChange={() => {}}
          onMessage={setMessage}
          publishedGeneration={published}
          onPublishedGenerationChange={setPublished}
          matchId={m.id}
        />
        {published && (
          <div className="border rounded-lg p-3 text-sm space-y-2">
            <div className="text-emerald-700">Teams saved for this match.</div>
            {view.canManage &&
              (view.telegram.poll?.pollId ? (
                <button type="button" className="bg-sky-600 text-white rounded px-3 py-1 disabled:opacity-60" disabled={busy} onClick={() => postTeams("post")}>
                  Post Teams to Telegram
                </button>
              ) : (
                <div className="text-gray-600">To post teams to Telegram, post this match&apos;s attendance poll first.</div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
