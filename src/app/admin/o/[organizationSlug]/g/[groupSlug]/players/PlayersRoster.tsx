"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CirclePause, CirclePlay, Pencil, Plus, Search, Trash2, UserRound, Users, X } from "lucide-react";
import { formatPlayerRating } from "@/lib/playerRating";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { ratingLabel } from "@/lib/labels";
import { roleLabel, type SportClientView } from "@/lib/sports";
import { emptyPlayerForm, playerFormFromPlayer, playerFormToBody, type PlayerFormValues } from "@/lib/canonicalAdminState";
import { newPlayerRoleKey } from "@/lib/sports";
import { filterRoster, fullName, initials, rosterSummary, type RosterStatusFilter } from "@/lib/playerRoster";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/app/Dialog";
import { cn } from "@/lib/cn";
import CanonicalPlayerForm from "../CanonicalPlayerForm";
import PlayerAccountCell from "../PlayerAccountCell";
import PlayerTelegramCell from "../PlayerTelegramCell";
import type { Player } from "../CanonicalAdminWorkspace";

/**
 * UI-5 — organizer Players page (visual reference: the approved Lovable
 * Players screen). Real data and the SAME tenant-bound APIs as before:
 *   GET/POST /players, PATCH/DELETE /players/[id] (OWNER/ADMIN — enforced
 *   server-side since UI-4A), claim links and Telegram unlink via the
 *   existing PlayerAccountCell / PlayerTelegramCell.
 * Positions come from the Group's sport registry. No bulk actions.
 * MEMBER: read-only roster without balancing data (skill/stamina) or actions.
 */

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold", active ? "border-primary/25 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", active ? "bg-primary" : "bg-muted-foreground")} aria-hidden="true" />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

/** Stamina 1–5 as a small meter WITH the number (never color/shape alone). */
function Stamina({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-2" title="Stamina: 1 = lower endurance, 5 = higher endurance">
      <span className="flex gap-0.5" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cn("h-2.5 w-1.5 rounded-sm", i <= value ? "bg-primary" : "bg-border")} />
        ))}
      </span>
      <span className="tabular-nums">
        {value}
        <span className="sr-only"> of 5</span>
      </span>
    </span>
  );
}

function Avatar({ p }: { p: Player }) {
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold", p.isActive ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground")} aria-hidden="true">
      {initials(p)}
    </span>
  );
}

export default function PlayersRoster({
  organizationSlug,
  groupSlug,
  groupName,
  sport,
  canManage,
}: {
  organizationSlug: string;
  groupSlug: string;
  groupName: string;
  sport: SportClientView;
  canManage: boolean;
}) {
  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });
  const playerUrl = useCallback((id: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${id}` }), [organizationSlug, groupSlug]);
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<RosterStatusFilter>("all");
  const [role, setRole] = useState<string>("all");
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; player: Player } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Player | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // One-time claim URLs live in transient memory only (never storage), as in the group page.
  const [claimLinks, setClaimLinks] = useState<Record<string, string>>({});
  // M9.2 — Communities (rosters): filter + membership management.
  const [communities, setCommunities] = useState<Array<{ id: string; name: string; isActive: boolean }>>([]);
  const [community, setCommunity] = useState<string>("all");
  const [addingTo, setAddingTo] = useState(false);
  const [addQ, setAddQ] = useState("");
  const communitiesUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/communities" });
  const membershipUrl = useCallback((cid: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/communities/${cid}/players` }), [organizationSlug, groupSlug]);
  const loadCommunities = useCallback(async () => {
    const res = await fetch(communitiesUrl, { cache: "no-store" });
    if (res.ok) setCommunities((await res.json()).communities ?? []);
  }, [communitiesUrl]);
  useEffect(() => {
    loadCommunities();
  }, [loadCommunities]);
  const communityName = (id: string) => communities.find((c) => c.id === id)?.name ?? "Community";
  async function setMembership(p: Player, cid: string, member: boolean) {
    setMessage(null);
    setBusyId(p.id);
    try {
      const res = await fetch(membershipUrl(cid), { method: member ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: p.id }) });
      setMessage(res.ok ? `${fullName(p)} ${member ? "added to" : "removed from"} ${communityName(cid)}.` : "Could not update the community.");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const load = useCallback(async () => {
    const res = await fetch(playersUrl, { cache: "no-store" });
    if (!res.ok) return setLoadError(true);
    setLoadError(false);
    setPlayers(await res.json());
  }, [playersUrl]);
  useEffect(() => {
    load();
  }, [load]);

  const list = useMemo(
    () => filterRoster(players ?? [], { q, status, role }).filter((p) => community === "all" || (p.communityIds ?? []).includes(community)),
    [players, q, status, role, community]
  );
  const summary = rosterSummary(players ?? []);
  const detail = (players ?? []).find((p) => p.id === detailId) ?? null;
  const filtersActive = status !== "all" || role !== "all" || community !== "all";
  const selectedCommunity = communities.find((c) => c.id === community) ?? null;
  const addable = selectedCommunity
    ? (players ?? []).filter((p) => !(p.communityIds ?? []).includes(selectedCommunity.id) && fullName(p).toLowerCase().includes(addQ.trim().toLowerCase()))
    : [];
  const roleOf = (key: string) => roleLabel(sport.key, key);

  async function create(values: PlayerFormValues): Promise<string | null> {
    setMessage(null);
    const res = await fetch(playersUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(playerFormToBody(values)) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data?.error ?? "Failed to create player";
    setForm(null);
    setMessage(`${values.firstName.trim()} ${values.lastName.trim()} added.`);
    await load();
    return null;
  }
  async function save(id: string, values: PlayerFormValues): Promise<string | null> {
    setMessage(null);
    const res = await fetch(playerUrl(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(playerFormToBody(values)) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data?.error ?? "Failed to update player";
    setForm(null);
    setMessage("Player updated.");
    await load();
    return null;
  }
  async function toggleActive(p: Player) {
    setMessage(null);
    setBusyId(p.id);
    try {
      const res = await fetch(playerUrl(p.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !p.isActive }) });
      setMessage(res.ok ? `${fullName(p)} ${p.isActive ? "deactivated" : "activated"}.` : "Failed to update player");
      await load();
    } finally {
      setBusyId(null);
    }
  }
  async function remove(p: Player) {
    setMessage(null);
    setBusyId(p.id);
    try {
      const res = await fetch(playerUrl(p.id), { method: "DELETE" });
      setConfirmDelete(null);
      if (res.ok && detailId === p.id) setDetailId(null);
      setMessage(res.ok ? `Deleted ${fullName(p)}.` : "Failed to delete player");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const actions = (p: Player) =>
    canManage && (
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" onClick={() => setForm({ mode: "edit", player: p })} className={cn("inline-flex min-h-9 items-center gap-1 rounded-tbp-sm px-2 text-sm font-semibold text-primary hover:bg-muted", focusRing)}>
          <Pencil className="size-4" aria-hidden="true" />
          Edit<span className="sr-only"> {fullName(p)}</span>
        </button>
        <button type="button" disabled={busyId === p.id} onClick={() => toggleActive(p)} className={cn("inline-flex min-h-9 items-center gap-1 rounded-tbp-sm px-2 text-sm font-semibold hover:bg-muted disabled:opacity-50", focusRing)}>
          {p.isActive ? <CirclePause className="size-4" aria-hidden="true" /> : <CirclePlay className="size-4" aria-hidden="true" />}
          {p.isActive ? "Deactivate" : "Activate"}
          <span className="sr-only"> {fullName(p)}</span>
        </button>
        <button type="button" onClick={() => setDetailId(p.id)} className={cn("inline-flex min-h-9 items-center gap-1 rounded-tbp-sm px-2 text-sm font-semibold hover:bg-muted", focusRing)}>
          <UserRound className="size-4" aria-hidden="true" />
          Account<span className="sr-only"> and Telegram for {fullName(p)}</span>
        </button>
      </div>
    );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow truncate">{groupName}</p>
          <h1 className="mt-1 text-3xl font-extrabold">Players</h1>
          {players && (
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{summary.total} players</span> · {summary.active} active · {summary.inactive} inactive · {sport.label}
            </p>
          )}
        </div>
        {canManage && (
          <Button type="button" onClick={() => setForm({ mode: "add" })}>
            <Plus aria-hidden="true" /> Add Player
          </Button>
        )}
      </header>

      {message && (
        <p role="status" aria-live="polite" className="rounded-tbp border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground">
          {message}
        </p>
      )}
      {!canManage && <p className="text-sm text-muted-foreground">The group&apos;s roster. Owners and admins manage players.</p>}

      {loadError ? (
        <p role="alert" className="text-sm text-destructive">Could not load players.</p>
      ) : !players ? (
        <p role="status" className="text-sm text-muted-foreground">Loading players…</p>
      ) : players.length === 0 ? (
        <section className="rounded-tbp-2xl border border-dashed border-border bg-card p-8 text-center">
          <h2 className="text-xl font-extrabold">No players yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {canManage ? "Add the people who play in this group. Skill and stamina are used only to balance teams." : "Owners and admins add players to this group."}
          </p>
          {canManage && (
            <Button type="button" className="mt-5" onClick={() => setForm({ mode: "add" })}>
              <Plus aria-hidden="true" /> Add Player
            </Button>
          )}
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search players"
                aria-label="Search players"
                className="h-10 w-full rounded-tbp-md border border-input bg-card pl-9 pr-9 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
              />
              {q && (
                <button type="button" onClick={() => setQ("")} aria-label="Clear search" className={cn("absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-tbp-sm text-muted-foreground hover:text-foreground", focusRing)}>
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
            {communities.length > 0 && (
              <label className="text-xs font-semibold text-muted-foreground">
                Community
                <select value={community} onChange={(e) => setCommunity(e.target.value)} className="mt-1 block h-10 max-w-[16rem] rounded-tbp-md border border-input bg-card px-2 text-sm text-foreground">
                  <option value="all">All players</option>
                  {communities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isActive ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="text-xs font-semibold text-muted-foreground">
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value as RosterStatusFilter)} className="mt-1 block h-10 rounded-tbp-md border border-input bg-card px-2 text-sm text-foreground">
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-muted-foreground">
              {sport.terminology.roleNoun}
              <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 block h-10 rounded-tbp-md border border-input bg-card px-2 text-sm text-foreground">
                <option value="all">All</option>
                {sport.roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            {filtersActive && (
              <Button type="button" variant="ghost" size="sm" className="h-10" onClick={() => (setStatus("all"), setRole("all"), setCommunity("all"))}>
                Clear filters
              </Button>
            )}
            {canManage && selectedCommunity && (
              <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => (setAddQ(""), setAddingTo(true))}>
                <Users aria-hidden="true" /> Add players to {selectedCommunity.name}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {list.length === players.length ? `Showing all ${players.length}` : `Showing ${list.length} of ${players.length}`}
          </p>

          {list.length === 0 ? (
            <div className="rounded-tbp-2xl border border-dashed border-border bg-card p-8 text-center">
              <p className="font-semibold">No players match</p>
              <p className="mt-1 text-sm text-muted-foreground">Try a different name or clear the filters.</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto rounded-tbp-2xl border border-border bg-card shadow-card md:block">
                <table className="w-full text-sm">
                  <caption className="sr-only">Players in {groupName}</caption>
                  <thead className="border-b border-border bg-secondary/50 text-left text-xs font-semibold text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-2.5 pl-4 pr-3">Player</th>
                      <th scope="col" className="py-2.5 pr-3">{sport.terminology.roleNoun}</th>
                      {canManage && <th scope="col" className="py-2.5 pr-3">Skill</th>}
                      {canManage && <th scope="col" className="py-2.5 pr-3">Stamina</th>}
                      {canManage && (
                        <th scope="col" className="py-2.5 pr-3" title="0–10, from skill and stamina (the balance engine's strength)">
                          Rating
                        </th>
                      )}
                      {communities.length > 0 && <th scope="col" className="hidden py-2.5 pr-3 xl:table-cell">Communities</th>}
                      <th scope="col" className="py-2.5 pr-3">Status</th>
                      <th scope="col" className="hidden py-2.5 pr-3 lg:table-cell">Account</th>
                      <th scope="col" className="hidden py-2.5 pr-3 lg:table-cell">Telegram</th>
                      {canManage && (
                        <th scope="col" className="py-2.5 pr-3">
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id} className={cn("border-b border-border last:border-0", !p.isActive && "text-muted-foreground")}>
                        <td className="py-2.5 pl-4 pr-3">
                          <span className="flex items-center gap-2.5">
                            <Avatar p={p} />
                            <span className={cn("font-semibold", p.isActive && "text-foreground")}>{fullName(p)}</span>
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">{roleOf(p.position)}</td>
                        {canManage && <td className="py-2.5 pr-3">{ratingLabel(p.rating)}</td>}
                        {canManage && (
                          <td className="py-2.5 pr-3">
                            <Stamina value={Number(p.stamina)} />
                          </td>
                        )}
                        {canManage && <td className="py-2.5 pr-3 font-semibold tabular-nums">{typeof p.playerRating === "number" ? formatPlayerRating(p.playerRating) : "—"}</td>}
                        {communities.length > 0 && (
                          <td className="hidden py-2.5 pr-3 text-xs xl:table-cell">
                            {(p.communityIds ?? []).length ? (p.communityIds ?? []).map((id) => communityName(id)).join(", ") : <span className="text-muted-foreground">None</span>}
                          </td>
                        )}
                        <td className="py-2.5 pr-3">
                          <StatusBadge active={p.isActive} />
                        </td>
                        <td className="hidden py-2.5 pr-3 text-xs lg:table-cell">{p.accountClaimed ? "Claimed" : p.claimPending ? "Link pending" : "—"}</td>
                        <td className="hidden py-2.5 pr-3 text-xs lg:table-cell">{p.telegramConnected ? "Connected" : "—"}</td>
                        {canManage && <td className="py-2 pr-3">{actions(p)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="space-y-2 md:hidden" aria-label={`Players in ${groupName}`}>
                {list.map((p) => (
                  <li key={p.id} className={cn("rounded-tbp-xl border border-border bg-card p-3 shadow-card", !p.isActive && "text-muted-foreground")}>
                    <div className="flex items-center gap-3">
                      <Avatar p={p} />
                      <div className="min-w-0 flex-1">
                        <p className={cn("truncate font-semibold", p.isActive && "text-foreground")}>{fullName(p)}</p>
                        <p className="text-xs text-muted-foreground">
                          {roleOf(p.position)}
                          {canManage ? ` · ${ratingLabel(p.rating)} · Stamina ${Number(p.stamina)}/5` : ""}
                          {canManage && typeof p.playerRating === "number" ? ` · Rating ${formatPlayerRating(p.playerRating)}` : ""}
                        </p>
                        {communities.length > 0 && (p.communityIds ?? []).length > 0 && (
                          <p className="truncate text-xs text-muted-foreground">{(p.communityIds ?? []).map((id) => communityName(id)).join(", ")}</p>
                        )}
                      </div>
                      <StatusBadge active={p.isActive} />
                    </div>
                    {canManage && <div className="mt-2 border-t border-border pt-2">{actions(p)}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {canManage && (
        <Dialog
          open={form !== null}
          title={form?.mode === "edit" ? `Edit ${fullName(form.player)}` : "Add Player"}
          description="Skill and stamina are used only to balance teams; players never see them."
          onClose={() => setForm(null)}
        >
          {form && (
            <CanonicalPlayerForm
              key={form.mode === "edit" ? form.player.id : "new"}
              initial={form.mode === "edit" ? playerFormFromPlayer(form.player) : emptyPlayerForm(newPlayerRoleKey(sport))}
              sport={sport}
              submitLabel={form.mode === "edit" ? "Save changes" : "Add player"}
              busyLabel={form.mode === "edit" ? "Saving…" : "Adding…"}
              onSubmit={(values) => (form.mode === "edit" ? save(form.player.id, values) : create(values))}
              onCancel={() => setForm(null)}
            />
          )}
          {form?.mode === "edit" && (
            <div className="mt-6 border-t border-border pt-4">
              {confirmDelete?.id === form.player.id ? (
                <div className="space-y-2 rounded-tbp border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
                  <p>
                    Delete <b>{fullName(form.player)}</b>? This removes the player from this group. Published teams are not changed.
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" variant="destructive" size="sm" disabled={busyId === form.player.id} onClick={() => (remove(form.player), setForm(null))}>
                      Delete player
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(form.player)} className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-tbp-sm px-2 text-sm font-semibold text-destructive hover:bg-destructive/5", focusRing)}>
                  <Trash2 className="size-4" aria-hidden="true" /> Delete player…
                </button>
              )}
            </div>
          )}
        </Dialog>
      )}

      {canManage && selectedCommunity && (
        <Dialog open={addingTo} title={`Add players to ${selectedCommunity.name}`} description="Adds an existing player to this community. Their other communities are not changed." onClose={() => setAddingTo(false)}>
          <input
            type="search"
            value={addQ}
            onChange={(e) => setAddQ(e.target.value)}
            placeholder="Search players"
            aria-label="Search players to add"
            className="mb-3 h-10 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          />
          {addable.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everyone matching is already in {selectedCommunity.name}.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {addable.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-tbp-sm px-1 py-1">
                  <span className="min-w-0 truncate text-sm">
                    {fullName(p)}
                    <span className="text-muted-foreground"> · {roleOf(p.position)}</span>
                  </span>
                  <Button type="button" size="sm" variant="outline" disabled={busyId === p.id} onClick={() => setMembership(p, selectedCommunity.id, true)}>
                    Add<span className="sr-only"> {fullName(p)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      )}

      {canManage && (
        <Dialog open={detail !== null} title={detail ? fullName(detail) : ""} description="Optional account and Telegram connection for this player." onClose={() => setDetailId(null)}>
          {detail && (
            <div className="space-y-4 text-sm">
              <section>
                <h3 className="mb-1 font-semibold">Team Balance Pro account</h3>
                <PlayerAccountCell
                  organizationSlug={organizationSlug}
                  groupSlug={groupSlug}
                  player={detail}
                  oneTimeLink={claimLinks[detail.id] ?? null}
                  onLinkCreated={(id, url) => setClaimLinks((m) => ({ ...m, [id]: url }))}
                  onLinkCleared={(id) => setClaimLinks((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))}
                  onChanged={load}
                  onMessage={setMessage}
                />
              </section>
              <section>
                <h3 className="mb-1 font-semibold">Telegram</h3>
                <PlayerTelegramCell organizationSlug={organizationSlug} groupSlug={groupSlug} player={detail} onChanged={load} onMessage={setMessage} />
              </section>
              {communities.length > 0 && (
                <section>
                  <h3 className="mb-1 font-semibold">Communities</h3>
                  <p className="mb-2 text-xs text-muted-foreground">Which rosters this player belongs to. Removing a community never deletes the player.</p>
                  <ul className="space-y-1">
                    {communities.map((c) => {
                      const member = (detail.communityIds ?? []).includes(c.id);
                      return (
                        <li key={c.id}>
                          <label className="flex min-h-9 items-center gap-2">
                            <input type="checkbox" className="size-4" checked={member} disabled={busyId === detail.id || (!c.isActive && !member)} onChange={(e) => setMembership(detail, c.id, e.target.checked)} />
                            <span>
                              {c.name}
                              {c.isActive ? "" : " (inactive)"}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
