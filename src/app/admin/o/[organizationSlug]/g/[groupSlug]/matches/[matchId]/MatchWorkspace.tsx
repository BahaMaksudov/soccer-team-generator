"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { PublishedGeneration, TeamsDeliveryState } from "@/lib/closeAndPostUi";
import TeamsTelegramPost, { type TeamsPostIntent } from "./TeamsTelegramPost";
import type { SportClientView } from "@/lib/sports";
import { unpublishedPreviewOnScreen, type TeamsPanelMode } from "@/lib/teamAssignment";
import { visibleRosterIds } from "@/lib/matchRosterScope";
import { adminGroupSettingsPath } from "@/lib/matchPaths";
import PostGameSection, { type PostGameView } from "./PostGameSection";
import { MATCH_TELEGRAM_GROUP_SELECTOR_ID } from "@/lib/postGameUi";
import CanonicalGenerateSection from "../../CanonicalGenerateSection";
import { PublishedTeams } from "@/components/game-day/PublishedTeams";
import { ArrowDown, CalendarClock, CircleCheck, Send, Shuffle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { focusRing, LifecycleSteps, MatchMeta, PhasePill, SectionCard, StateChip } from "@/components/game-day/parts";
import { matchLifecycle, todayUtcYmd } from "@/lib/matchLifecycle";
import { cn } from "@/lib/cn";
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
 *
 * UI-4 — redesigned presentation (header, progress with ONE suggested next
 * step, sectioned cards). Every request, payload and permission is unchanged.
 */

type Status = "PLAYING" | "NOT_PLAYING" | "MAYBE";
type RosterPlayer = Player & {
  attendance: { status: Status | null; source: "WEB" | "TELEGRAM" | "OVERRIDE" | null; overridden: boolean; late: boolean; participantStatus: Status | null; participantSource: "WEB" | "TELEGRAM" | null };
};
type MatchView = {
  match: {
    id: string;
    date: string;
    startTime: string | null;
    locationName: string | null;
    status: "SCHEDULED" | "COMPLETED" | "CANCELED";
    attendanceClosed: boolean;
    /** M9.2 — reusable Venue (address + keyless maps link). */
    venue?: { id: string; name: string; address: string | null; mapsUrl: string | null } | null;
  };
  canManage: boolean;
  roster: RosterPlayer[];
  counts: { PLAYING: number; MAYBE: number; NOT_PLAYING: number; NO_RESPONSE: number };
  /** M9.2 — eligible roster size (the four counts add up to it). */
  rosterSize?: number;
  /** M9.2 — the Match's Community (null = legacy Match, whole-Group roster). */
  community?: { id: string; name: string; isActive: boolean } | null;
  /** OWNER/ADMIN: the Group's active Communities (to assign one to a legacy Match). */
  communities?: Array<{ id: string; name: string }>;
  /** M9.2 — what Match Automation did (organizers; null when the Match was not created by a schedule). */
  automation?: {
    scheduleActive: boolean;
    pollDueAt: string;
    cutoffDueAt: string;
    pollPostedAt: string | null;
    cutoffCompletedAt: string | null;
    notifiedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  } | null;
  defaultSelection: string[];
  generation: { id: string; date: string; updatedAt: string; teams: Array<{ teamNumber: number; players: Array<{ id: string; firstName: string; lastName: string; position: string }> }> } | null;
  // M9-B — selected chat's default player scope (ids only); chats/selection/suggestions are OWNER/ADMIN only.
  scope: { chatSelected: boolean; playerIds: string[] };
  playerPage: { path: string; visibility: "PUBLIC" | "LINK" | "PRIVATE" };
  postGame: PostGameView | null;
  telegram: {
    connected: boolean;
    chats: Array<{ ref: number; title: string }>;
    selectedChat: { ref: number; title: string; connected: boolean } | null;
    suggestedPlayerIds: string[];
    poll: { pollId: string | null; closed: boolean; postedAt: string } | null;
    unlinkedVoters: number;
    pollDelivery: { status: string; sentAt: string | null } | null;
  };
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
  // M9-B — the Match's selected Telegram chat is server state (survives reload).
  const chats = view?.telegram.chats ?? [];
  const chatRef = view?.telegram.selectedChat?.connected ? view.telegram.selectedChat.ref : null;
  // Roster presentation only (never eligibility): players added for this view, or everyone.
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [addPick, setAddPick] = useState("");
  // M9-C — LINK Groups: the organizer pastes the Group's CURRENT share link; the
  // server validates it and links the post to this Match (/share/m/<id>#token).
  const [shareUrl, setShareUrl] = useState("");
  const [edit, setEdit] = useState<{ date: string; startTime: string; locationName: string; venueId: string } | null>(null);
  // M9.2 — the Organization's Venues (loaded when the organizer edits the match).
  const [venues, setVenues] = useState<Array<{ id: string; name: string; address: string | null; isActive: boolean }>>([]);
  useEffect(() => {
    if (!edit || venues.length) return;
    fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/venues" }), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { venues: [] }))
      .then((d) => setVenues(d.venues ?? []))
      .catch(() => {});
  }, [edit, venues.length, organizationSlug, groupSlug]);
  // Telegram state of the PUBLISHED teams, from durable MessageDelivery content hashes (server).
  const [teamsDelivery, setTeamsDelivery] = useState<TeamsDeliveryState | null>(null);
  // M9.1 — the delivery record recovery actions target (uncertain → mark as sent / retry).
  const [teamsDeliveryId, setTeamsDeliveryId] = useState<string | null>(null);
  // M9-A — Telegram team posting is hidden while an unpublished preview is on screen;
  // the post itself always sends the canonical published TeamGeneration (by id).
  const [panelMode, setPanelMode] = useState<TeamsPanelMode>("none");

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

  // After a Publish (new generation id) re-read the Match so the published teams come from the server.
  const publishedId = published?.id ?? null;
  useEffect(() => {
    if (publishedId && view?.generation?.id !== publishedId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedId]);

  const pollId = view?.telegram.poll?.pollId ?? null;
  const generationKey = view?.generation ? `${view.generation.id}:${view.generation.updatedAt}` : null;
  const loadTeamsDelivery = useCallback(async () => {
    if (!view?.canManage || !pollId || !view.generation) {
      setTeamsDeliveryId(null);
      return setTeamsDelivery(null);
    }
    const q = new URLSearchParams({ pollId, teamGenerationId: view.generation.id });
    const res = await fetch(`${adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/delivery" })}?${q}`, { cache: "no-store" });
    const data = res.ok ? await res.json() : null;
    setTeamsDelivery(data?.state ?? null);
    setTeamsDeliveryId(data?.deliveryId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.canManage, pollId, generationKey, organizationSlug, groupSlug]);
  useEffect(() => {
    loadTeamsDelivery();
  }, [loadTeamsDelivery]);

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

  // M9-B — OWNER/ADMIN: add/remove a Player in the selected chat's default scope (saves only).
  async function changeScope(playerId: string, method: "POST" | "DELETE", fromSuggestion = false) {
    if (!view?.telegram.selectedChat) return;
    setBusy(true);
    setMessage(null);
    try {
      const path = `/channels/telegram/${view.telegram.selectedChat.ref}/players`;
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path }), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, fromSuggestion }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? (method === "POST" ? "Added to this Telegram group's players." : "Removed from this Telegram group's players.") : data?.error ?? "Something went wrong.");
      await load();
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

  async function postTeams(intent: TeamsPostIntent = "post", deliveryId?: string) {
    if (!view?.telegram.poll?.pollId || !published) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/close-and-post" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: view.telegram.poll.pollId, teamGenerationId: published.id, intent, ...(deliveryId ? { deliveryId } : {}), ...(shareUrl.trim() ? { shareUrl: shareUrl.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? (data.status === "already_posted" ? "These teams were already posted — nothing was sent again." : "Teams posted to Telegram.") : data?.error ?? "Could not post the teams.");
      await loadTeamsDelivery();
    } finally {
      setBusy(false);
    }
  }

  // M9.2 — assign a Community to a legacy Match (server validates it is this Group's).
  async function setCommunity(communityId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api(""), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId }) });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? "Community saved for this match. Nothing was sent." : data?.error ?? "Could not save the community.");
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function addToCommunity(playerId: string) {
    if (!view?.community) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/communities/${view.community.id}/players` }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      setMessage(res.ok ? `Added to ${view.community.name}.` : "Could not add the player to the community.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  // M9.1 — organizer recovery for an uncertain delivery: records the decision only (the server never sends here).
  async function markTeamsSent(deliveryId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/telegram/delivery" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_sent", deliveryId }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? "Marked as sent. Nothing was posted to Telegram." : data?.error ?? "Could not mark the teams as sent.");
      await loadTeamsDelivery();
    } finally {
      setBusy(false);
    }
  }

  const players = useMemo(() => (view?.roster ?? []).map(({ attendance: _a, ...p }) => p as Player), [view]);
  const defaultIds = useMemo(() => view?.defaultSelection ?? [], [view]);
  const selectedIds = useMemo(() => computeSelection(defaultIds, adjustments), [defaultIds, adjustments]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // M9-B — default roster = selected chat's scope + anyone with Match state + players added here.
  // M9.2 — only the Match Community's players are selectable; outsiders with Match state are listed separately.
  const activeRoster = useMemo(() => (view?.roster ?? []).filter((p) => p.isActive && p.inCommunity !== false), [view]);
  const outsiders = useMemo(() => (view?.roster ?? []).filter((p) => p.inCommunity === false), [view]);
  const namesBy = useMemo(() => {
    const by: Record<"PLAYING" | "MAYBE" | "NOT_PLAYING" | "NO_RESPONSE", string[]> = { PLAYING: [], MAYBE: [], NOT_PLAYING: [], NO_RESPONSE: [] };
    for (const p of activeRoster) by[p.attendance.status ?? "NO_RESPONSE"].push(`${p.firstName} ${p.lastName}`);
    return by;
  }, [activeRoster]);
  const scopeSet = useMemo(() => new Set(view?.scope.playerIds ?? []), [view]);
  const visibleIds = useMemo(() => {
    const withMatchState = new Set<string>(selectedIds);
    for (const p of activeRoster) if (p.attendance.status !== null || p.attendance.participantStatus !== null) withMatchState.add(p.id);
    for (const t of view?.generation?.teams ?? []) for (const pl of t.players) withMatchState.add(pl.id);
    return new Set(
      visibleRosterIds({ rosterIds: activeRoster.map((p) => p.id), chatSelected: view?.scope.chatSelected ?? false, scopeIds: view?.scope.playerIds ?? [], withMatchState, addedIds, showAll })
    );
  }, [activeRoster, view, selectedIds, addedIds, showAll]);
  const visiblePlayers = activeRoster.filter((p) => visibleIds.has(p.id));
  const hiddenPlayers = activeRoster.filter((p) => !visibleIds.has(p.id));
  const scopeManageable = Boolean(view?.canManage && view.telegram.selectedChat?.connected);
  const suggestedPlayers = activeRoster.filter((p) => (view?.telegram.suggestedPlayerIds ?? []).includes(p.id));

  if (notFound)
    return (
      <div className="rounded-tbp-2xl border border-border bg-card p-6 text-center">
        <h1 className="text-2xl font-extrabold">Match not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">This match doesn&apos;t exist in this group.</p>
      </div>
    );
  if (!view)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading match…
      </p>
    );
  const m = view.match;
  const pg = view.postGame;
  // UI-4 — presentation only, from the real view (src/lib/matchLifecycle.ts).
  const lifecycle = matchLifecycle({
    status: m.status,
    date: m.date,
    today: todayUtcYmd(),
    attendanceClosed: m.attendanceClosed,
    playing: view.counts.PLAYING,
    teamsPublished: view.generation !== null,
    result: { saved: Boolean(pg?.result), published: Boolean(pg?.result?.published) },
    mvpPublished: Boolean(pg?.mvp?.published),
    recap: { saved: Boolean(pg?.recap?.content), published: Boolean(pg?.recap?.published) },
    summary: pg?.messages?.summary ?? null,
    canManage: view.canManage,
  });
  const next = lifecycle.next;
  const smallBtn = "inline-flex min-h-9 items-center rounded-tbp-sm px-3 text-sm font-semibold disabled:opacity-50";
  const input = "h-11 rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm";

  return (
    <div className="space-y-6">
      {/* Match header */}
      <header className="rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PhasePill phase={lifecycle.phase} label={lifecycle.phaseLabel} />
              {m.status === "COMPLETED" && <StateChip tone="done">Marked completed</StateChip>}
            </div>
            <h1 className="mt-2 text-2xl font-extrabold sm:text-3xl">{formatLongDateOnly(m.date)}</h1>
            <MatchMeta date={m.date} startTime={m.startTime} locationName={m.locationName} className="mt-1 [&>li:first-child]:hidden" />
            {m.venue?.address && m.venue.mapsUrl && (
              <a className={cn("mt-1 inline-block break-words text-sm font-semibold text-primary underline", focusRing)} href={m.venue.mapsUrl} target="_blank" rel="noopener noreferrer">
                📍 {m.venue.address}
              </a>
            )}
          </div>
          {/* UI-4A — match management is OWNER/ADMIN only (enforced server-side). */}
          {view.canManage && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={cn(smallBtn, "border border-input hover:bg-muted", focusRing)} onClick={() => setEdit({ date: m.date, startTime: m.startTime ?? "", locationName: m.locationName ?? "", venueId: m.venue?.id ?? "" })}>Edit</button>
            {m.status === "SCHEDULED" ? (
              <>
                <button type="button" className={cn(smallBtn, "border border-input hover:bg-muted", focusRing)} disabled={busy} onClick={() => saveMatch({ status: "COMPLETED" }, "Marked as completed.")}>Mark completed</button>
                <button type="button" className={cn(smallBtn, "border border-destructive/40 text-destructive hover:bg-destructive/5", focusRing)} disabled={busy} onClick={() => saveMatch({ status: "CANCELED" }, "Match canceled. Nothing was sent.")}>Cancel match</button>
              </>
            ) : (
              <button type="button" className={cn(smallBtn, "border border-input hover:bg-muted", focusRing)} disabled={busy} onClick={() => saveMatch({ status: "SCHEDULED" }, "Match reopened.")}>Reopen</button>
            )}
          </div>
          )}
        </div>
        {view.canManage && edit && (
          <form
            className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const { venueId, ...rest } = edit;
              saveMatch({ ...rest, venueId: venueId || null }, "Match saved. Nothing was sent.");
            }}
          >
            <label className="text-sm font-semibold">Date<input type="date" className={cn(input, "mt-1 block w-full font-normal")} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></label>
            <label className="text-sm font-semibold">Start time<input type="time" className={cn(input, "mt-1 block w-full font-normal")} value={edit.startTime} onChange={(e) => setEdit({ ...edit, startTime: e.target.value })} /></label>
            <label className="text-sm font-semibold">
              Venue
              <select
                className={cn(input, "mt-1 block w-full font-normal")}
                value={edit.venueId}
                onChange={(e) => {
                  const v = venues.find((x) => x.id === e.target.value);
                  setEdit({ ...edit, venueId: e.target.value, ...(v ? { locationName: v.name } : {}) });
                }}
              >
                <option value="">No saved venue</option>
                {venues.filter((v) => v.isActive || v.id === edit.venueId).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">Location name<input className={cn(input, "mt-1 block w-full font-normal")} maxLength={80} placeholder="Location" value={edit.locationName} onChange={(e) => setEdit({ ...edit, locationName: e.target.value })} /></label>
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={busy}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            </div>
          </form>
        )}
      </header>

      {message && (
        <p role="status" aria-live="polite" className="rounded-tbp border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground">
          {message}
        </p>
      )}

      {/* Progress + the ONE suggested next step (it points at the section holding the real control). */}
      <section aria-labelledby="progress-h" className="space-y-3 rounded-tbp-2xl bg-pitch p-4 text-pitch-foreground shadow-lift pitch-lines sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="progress-h" className="text-xs font-bold uppercase tracking-widest text-accent">Match progress</h2>
            <p className="mt-1 text-lg font-extrabold">
              {next
                ? `Next: ${next.label}`
                : lifecycle.phase === "canceled"
                  ? "This match is canceled."
                  : lifecycle.phase === "complete"
                    ? "Post-game is complete."
                    : view.canManage
                      ? "Nothing to do right now."
                      : "You're viewing this match. Owners and admins manage it."}
            </p>
          </div>
          {next && (
            <a href={next.anchor} className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-foreground hover:brightness-105", focusRing)}>
              {next.label}
              <ArrowDown className="size-4" aria-hidden="true" />
            </a>
          )}
        </div>
        <LifecycleSteps lifecycle={lifecycle} linkBase="" onDark />
      </section>

      {/* M9.2 — Match Automation status (organizers) */}
      {view.canManage && view.automation && <AutomationCard a={view.automation} teamsPublished={view.generation !== null} busy={busy} onRun={() => call("/automation", {}, "Automation ran for this match. Nothing is published automatically.")} />}

      {/* Attendance */}
      <SectionCard
        id="attendance"
        title="Attendance"
        icon={<Users className="size-5" />}
        meta={m.attendanceClosed ? "Attendance closed" : "Attendance open"}
      >
        {view.community ? (
          <p className="mb-3 text-sm">
            <span className="text-muted-foreground">Community:</span> <span className="font-semibold">{view.community.name}</span>
          </p>
        ) : (
          view.canManage &&
          (view.communities ?? []).length > 0 && (
            <div role="note" className="mb-3 flex flex-wrap items-center gap-2 rounded-tbp-xl border border-accent/40 bg-accent/10 p-3 text-sm">
              <span className="min-w-0 flex-1 basis-56">This match has no community yet, so every player in the group is listed. Choose the community it belongs to:</span>
              <label className="sr-only" htmlFor="match-community">Community</label>
              <select id="match-community" className="h-9 rounded-tbp-sm border border-input bg-card px-2" defaultValue="" disabled={busy} onChange={(e) => e.target.value && setCommunity(e.target.value)}>
                <option value="">Choose…</option>
                {(view.communities ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )
        )}
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {([
            ["PLAYING", "Playing"],
            ["MAYBE", "Maybe"],
            ["NOT_PLAYING", "Not playing"],
            ["NO_RESPONSE", "Not responded"],
          ] as const).map(([k, label]) => (
            <div key={k} className="rounded-tbp bg-muted px-3 py-2">
              <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
              <dd className="font-display text-2xl font-black tabular-nums">{view.counts[k]}</dd>
            </div>
          ))}
          <div className="col-span-2 rounded-tbp border border-border px-3 py-2 sm:col-span-1">
            <dt className="text-xs font-semibold text-muted-foreground">Roster</dt>
            <dd className="font-display text-2xl font-black tabular-nums">{view.rosterSize ?? activeRoster.length}</dd>
          </div>
        </dl>
        {view.canManage && (
          <details className="mt-3 text-sm">
            <summary className={cn("cursor-pointer font-semibold text-primary", focusRing)}>Who is in each group</summary>
            <dl className="mt-2 space-y-1">
              {([
                ["PLAYING", "Playing"],
                ["MAYBE", "Maybe"],
                ["NOT_PLAYING", "Not playing"],
                ["NO_RESPONSE", "Not responded"],
              ] as const).map(([k, label]) => (
                <div key={k} className="flex flex-wrap gap-x-2">
                  <dt className="font-semibold">{label} ({namesBy[k].length}):</dt>
                  <dd className="min-w-0 break-words text-muted-foreground">{namesBy[k].length ? namesBy[k].join(", ") : "—"}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" id={MATCH_TELEGRAM_GROUP_SELECTOR_ID}>
          {view.canManage && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => call("/attendance/close", { closed: !m.attendanceClosed }, m.attendanceClosed ? "Attendance reopened." : "Attendance closed.")}>
            {m.attendanceClosed ? "Reopen attendance" : "Close attendance"}
          </Button>
          )}
          {/* UI-4B — while closed, attendance is read-only (the server rejects sync too): reopen first. */}
          {view.canManage && !m.attendanceClosed && view.telegram.poll && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => call("/attendance/sync", {}, "Telegram attendance synced.")}>
              Sync Telegram attendance
            </Button>
          )}
          {view.canManage &&
            (view.telegram.connected && chats.length > 0 ? (
              <>
                <label className="flex items-center gap-2 font-semibold">
                  Telegram group
                  <select
                    className="h-9 rounded-tbp-sm border border-input bg-card px-2 font-normal"
                    value={chatRef ?? ""}
                    disabled={busy}
                    onChange={(e) => call("/telegram-chat", { chatRef: e.target.value ? Number(e.target.value) : null }, "Telegram group saved for this match. Nothing was sent.")}
                  >
                    <option value="">— choose —</option>
                    {chats.map((c) => (
                      <option key={c.ref} value={c.ref}>{c.title}</option>
                    ))}
                  </select>
                </label>
                <Button type="button" size="sm" disabled={busy || chatRef === null || m.status === "CANCELED"} onClick={() => call("/poll", { chatRef, intent: "post" }, "Attendance poll posted to Telegram.")}>
                  <Send aria-hidden="true" /> Post poll to Telegram
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">Telegram not connected — connect it in <Link className="font-semibold text-primary underline" href={`${adminGroupSettingsPath(organizationSlug, groupSlug)}#telegram`}>Group settings</Link>.</span>
            ))}
        </div>
        {view.canManage && view.telegram.pollDelivery && <p className="mt-2 text-xs text-muted-foreground">Last poll post: {view.telegram.pollDelivery.status.toLowerCase()}</p>}
        {/* M9.2 — publishing teams closes the attendance poll; if Telegram didn't confirm, close it again here (safe to repeat). */}
        {view.canManage && view.telegram.poll && !view.telegram.poll.closed && view.generation && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">The Telegram attendance poll is still open.</span>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => call("/poll/close", {}, "Attendance poll closed in Telegram.")}>
              Close Telegram poll
            </Button>
          </div>
        )}
        {view.telegram.unlinkedVoters > 0 && (
          <p className="mt-2 text-xs text-accent-foreground">
            {view.telegram.unlinkedVoters} Telegram voter(s) aren&apos;t linked to players{view.canManage ? <> — link them in <Link className="font-semibold text-primary underline" href={`${adminGroupSettingsPath(organizationSlug, groupSlug)}#telegram`}>Group settings</Link>.</> : "."}
          </p>
        )}

        {view.scope.chatSelected && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              Showing {view.telegram.selectedChat ? `${view.telegram.selectedChat.title}'s` : "this Telegram group's"} players and anyone already in this match.
            </span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="size-4 accent-primary" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all Group players
            </label>
            {view.canManage && hiddenPlayers.length > 0 && (
              <>
                <label className="sr-only" htmlFor="add-player-pick">Add another player</label>
                <select id="add-player-pick" className="h-9 rounded-tbp-sm border border-input bg-card px-2" value={addPick} onChange={(e) => setAddPick(e.target.value)}>
                  <option value="">+ Add another player…</option>
                  {hiddenPlayers.map((p) => (
                    <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
                <Button type="button" variant="ghost" size="sm" disabled={!addPick} onClick={() => { setAddedIds((ids) => [...ids, addPick]); setAddPick(""); }}>Add to this match</Button>
              </>
            )}
          </div>
        )}
        {scopeManageable && suggestedPlayers.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            Suggested for this Telegram group (linked players who voted there):
            {suggestedPlayers.map((p) => (
              <button key={p.id} type="button" disabled={busy} className={cn("font-semibold text-primary underline", focusRing)} onClick={() => changeScope(p.id, "POST", true)}>
                + {p.firstName} {p.lastName}
              </button>
            ))}
          </div>
        )}

        <ul className="mt-4 divide-y divide-border rounded-tbp-xl border border-border" aria-label="Player attendance">
          {visiblePlayers.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No players to show.</li>}
          {visiblePlayers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1 basis-44">
                <p className="truncate font-semibold">{p.firstName} {p.lastName}</p>
                <p className="text-sm">
                  {p.attendance.status ? STATUS_LABEL[p.attendance.status] : <span className="text-muted-foreground">No response</span>}
                  {p.attendance.source && <span className="text-xs text-muted-foreground"> · {SOURCE_LABEL[p.attendance.source]}</span>}
                  {p.attendance.late && <span className="text-xs font-semibold text-accent-foreground"> · late</span>}
                  {p.attendance.overridden && p.attendance.participantStatus && (
                    <span className="text-xs text-muted-foreground"> (player said {STATUS_LABEL[p.attendance.participantStatus]})</span>
                  )}
                </p>
              </div>
              {view.canManage && (
              <div className="flex flex-wrap items-center gap-1">
              {/* UI-4B — no per-player attendance changes while attendance is closed (also enforced server-side). */}
              {!m.attendanceClosed && (
              <div role="group" aria-label={`Set attendance for ${p.firstName} ${p.lastName}`} className="flex flex-wrap items-center gap-1">
                {(["PLAYING", "MAYBE", "NOT_PLAYING"] as Status[]).map((s) => {
                  const on = p.attendance.overridden && p.attendance.status === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={busy}
                      aria-pressed={on}
                      className={cn("min-h-9 rounded-full border px-3 text-xs font-semibold disabled:opacity-50", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted", focusRing)}
                      onClick={() => call("/attendance", { playerId: p.id, status: s }, "Attendance saved.")}
                    >
                      {STATUS_LABEL[s]}
                    </button>
                  );
                })}
                {p.attendance.overridden && (
                  <button type="button" disabled={busy} className={cn("min-h-9 rounded-full px-3 text-xs font-semibold text-destructive hover:bg-destructive/5", focusRing)} onClick={() => call("/attendance", { playerId: p.id, status: null }, "Override cleared.")}>
                    Clear override
                  </button>
                )}
              </div>
              )}
                {scopeManageable &&
                  (scopeSet.has(p.id) ? (
                    <button type="button" disabled={busy} className={cn("min-h-9 rounded-full px-3 text-xs text-muted-foreground underline", focusRing)} onClick={() => changeScope(p.id, "DELETE")}>In group · remove</button>
                  ) : (
                    <button type="button" disabled={busy} className={cn("min-h-9 rounded-full px-3 text-xs text-muted-foreground underline", focusRing)} onClick={() => changeScope(p.id, "POST")}>Add to group</button>
                  ))}
              </div>
              )}
            </li>
          ))}
        </ul>
        {outsiders.length > 0 && view.community && (
          <div className="mt-4 rounded-tbp-xl border border-dashed border-border p-3 text-sm">
            <p className="font-semibold">Not in {view.community.name}</p>
            <p className="text-xs text-muted-foreground">They answered or were added to this match but aren&apos;t members of its community, so they aren&apos;t counted or selected.</p>
            <ul className="mt-2 space-y-1">
              {outsiders.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {p.firstName} {p.lastName}
                    <span className="text-muted-foreground"> · {p.attendance.status ? STATUS_LABEL[p.attendance.status] : "No response"}</span>
                  </span>
                  {view.canManage && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => addToCommunity(p.id)}>
                      Add to {view.community!.name}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {view.canManage &&
          (m.attendanceClosed ? (
            <p role="note" className="mt-2 text-sm font-medium text-muted-foreground">Attendance is closed. Reopen attendance to make changes.</p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">The buttons set an organizer override; the player&apos;s own answer is kept.</p>
          ))}
      </SectionCard>

      {/* Teams */}
      <SectionCard id="teams" title="Teams" icon={<Shuffle className="size-5" />} meta={view.generation ? "Published for this match" : "Not published yet"}>
        {!view.canManage ? (
          // UI-4A — read-only for MEMBER: the published teams only (no generation controls).
          view.generation ? (
            <PublishedTeams teams={view.generation.teams} date={view.generation.date} sportKey={sport.key} />
          ) : (
            <p className="text-sm text-muted-foreground">Teams haven&apos;t been published for this match yet. Owners and admins build and publish teams.</p>
          )
        ) : (
        <>
        <p className="text-sm text-muted-foreground">Players marked Playing are selected. Maybe players are shown but not selected — add them if you want.</p>
        <fieldset className="mt-3">
          <legend className="sr-only">Players for team generation</legend>
          <div className="flex flex-wrap gap-2 text-sm">
            {visiblePlayers.map((p) => (
              <label key={p.id} className={cn("flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3", selectedSet.has(p.id) ? "border-primary bg-primary/5" : "border-input", p.attendance.status === "MAYBE" && "border-dashed")}>
                <input type="checkbox" className="size-4 accent-primary" checked={selectedSet.has(p.id)} onChange={() => setAdjustments((adj) => toggleSelection(defaultIds, adj, p.id))} />
                {p.firstName} {p.lastName}
                {p.attendance.status === "MAYBE" && <span className="text-xs text-accent-foreground">maybe</span>}
              </label>
            ))}
          </div>
        </fieldset>
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
          initialPublishedTeams={view.generation?.teams ?? null}
          onPanelModeChange={setPanelMode}
        />
        </>
        )}
        {published && !unpublishedPreviewOnScreen(panelMode) && (
          <div className="mt-4 space-y-2 rounded-tbp-xl border border-primary/20 bg-primary/5 p-4 text-sm">
            <p className="flex items-center gap-1.5 font-semibold text-primary"><CircleCheck className="size-4" aria-hidden="true" /> Teams saved for this match.</p>
            <p className="text-xs text-muted-foreground">
              Player page:{" "}
              {view.playerPage.visibility === "LINK" ? (
                <>only through the group&apos;s share link (players without an account) or for signed-in members/claimed players: <a className="font-semibold text-primary underline" href={view.playerPage.path} target="_blank" rel="noreferrer">open</a></>
              ) : (
                <>
                  <a className="break-all font-semibold text-primary underline" href={view.playerPage.path} target="_blank" rel="noreferrer">{view.playerPage.path}</a>
                  {view.playerPage.visibility === "PRIVATE" && " (signed-in members and claimed players only; Telegram posts carry no link)"}
                </>
              )}
            </p>
            {view.canManage && view.playerPage.visibility === "LINK" && view.telegram.poll?.pollId && teamsDelivery !== "posted" && (
              <>
                <label className="sr-only" htmlFor="teams-share-url">Group share link (optional)</label>
                <input
                  id="teams-share-url"
                  className={cn(input, "w-full text-xs")}
                  placeholder="Optional: paste the group's current share link so the Telegram post links to this match"
                  value={shareUrl}
                  onChange={(e) => setShareUrl(e.target.value)}
                  autoComplete="off"
                />
              </>
            )}
            {view.canManage &&
              (view.telegram.poll?.pollId ? (
                <TeamsTelegramPost state={teamsDelivery} deliveryId={teamsDeliveryId} busy={busy} onPost={postTeams} onMarkSent={markTeamsSent} />
              ) : (
                <p className="text-muted-foreground">To post teams to Telegram, post this match&apos;s attendance poll first.</p>
              ))}
          </div>
        )}
      </SectionCard>

      {/* M9-D — Result / MVP / Recap / Match Summary (each its own section inside PostGameSection) */}
      {view.postGame && (
        <PostGameSection
          pg={view.postGame}
          canManage={view.canManage}
          busy={busy}
          act={(body, ok) => call("/post-game", body, ok)}
          request={async (body) => {
            const res = await fetch(api("/post-game"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return { ok: res.ok, data: await res.json().catch(() => ({})) };
          }}
          notify={setMessage}
        />
      )}
    </div>
  );
}

/** M9.2 — what Match Automation did for this scheduled Match, and a safe Retry / Run now (only what is due runs). */
function AutomationCard({ a, teamsPublished, busy, onRun }: { a: NonNullable<MatchView["automation"]>; teamsPublished: boolean; busy: boolean; onRun: () => void }) {
  const at = (iso: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const now = Date.now();
  const steps: Array<{ label: string; state: string; done: boolean }> = [
    { label: "Match created", state: "Scheduled", done: true },
    {
      label: "Attendance poll",
      state: a.pollPostedAt ? `Sent ${at(a.pollPostedAt)}` : new Date(a.pollDueAt).getTime() > now ? `Scheduled for ${at(a.pollDueAt)}` : "Not sent yet",
      done: Boolean(a.pollPostedAt),
    },
    {
      label: "Attendance",
      state: a.cutoffCompletedAt ? `Ready (closed ${at(a.cutoffCompletedAt)})` : `Open until ${at(a.cutoffDueAt)}`,
      done: Boolean(a.cutoffCompletedAt),
    },
    { label: "Organizers notified", state: a.notifiedAt ? `Emailed ${at(a.notifiedAt)}` : "After the cutoff", done: Boolean(a.notifiedAt) },
    { label: "Teams", state: teamsPublished ? "Published" : a.cutoffCompletedAt ? "Awaiting organizer" : "After attendance", done: teamsPublished },
  ];
  return (
    <SectionCard id="automation" title="Automation" icon={<CalendarClock className="size-5" />} meta={a.scheduleActive ? "Recurring schedule" : "Schedule paused"}>
      <ol className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => (
          <li key={s.label} className={cn("rounded-tbp border px-3 py-2", s.done ? "border-primary/25 bg-primary/5" : "border-border")}>
            <p className="text-xs font-semibold text-muted-foreground">{s.label}</p>
            <p className="font-semibold">{s.state}</p>
          </li>
        ))}
      </ol>
      {a.lastError && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-tbp-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <span className="min-w-0 flex-1 basis-56 text-destructive">{a.lastError}</span>
          <Button type="button" size="sm" variant="outline" disabled={busy || !a.scheduleActive} onClick={onRun}>
            Retry
          </Button>
        </div>
      )}
      {!a.lastError && a.scheduleActive && (
        <p className="mt-3 text-xs text-muted-foreground">
          Runs automatically on schedule.{" "}
          <button type="button" className="font-semibold text-primary underline disabled:opacity-50" disabled={busy} onClick={onRun}>
            Run now
          </button>{" "}
          (only what is due runs; teams are never published automatically).
        </p>
      )}
    </SectionCard>
  );
}
