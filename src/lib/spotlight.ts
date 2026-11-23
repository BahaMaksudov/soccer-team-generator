import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { confirmedAttendeeIds, eligibleRosterIds, resolveCommunity } from "@/lib/attendanceSnapshot";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * Random Player Spotlight — one confirmed attendee per Match, chosen fairly at random, never the
 * same person twice in a rotation cycle.
 *
 * ROTATION SCOPE: a Match that belongs to a Community (Match.communityId — the authoritative
 * association, never a Telegram chat or a name) uses THAT Community's own rotation; a Match
 * without one uses the whole-Group rotation. Every pick records the scope it was drawn in
 * (SpotlightPick.communityId; NULL = whole Group — which is also where every pick made before
 * per-Community rotations lives). Scopes are fully independent: a player who belongs to two
 * Communities has a turn in each, and one scope's picks never count in another.
 *
 * CYCLE MEMBERSHIP POLICY (per scope):
 *   - The rotation roster is the scope's eligible roster at selection time — the same one the
 *     attendance counts use (attendanceSnapshot.eligibleRosterIds): the Community's ACTIVE
 *     members, or the Group's ACTIVE players for a whole-Group Match.
 *   - A player is "selected in cycle N" of a scope when they have an ACTIVE or REPLACED pick of
 *     that scope in cycle N.
 *   - Cycle N is complete when everyone on the roster has been selected in it. New members join
 *     the current cycle (unselected); deactivated or removed members stop counting toward
 *     completion (so the cycle can always finish) and, if reactivated, keep whatever status they
 *     had in the cycle; deleted players disappear with their picks.
 *   - The next cycle starts only at the first selection after the current one is complete — never
 *     early. Absent players simply stay unselected for a later match.
 *   - If every CONFIRMED attendee of this Match was already selected this cycle while other members
 *     are still waiting (but aren't attending), nothing is selected and nothing restarts: the
 *     organizer is told, and the Spotlight is simply left out of this Match.
 *
 * SELECTION: explicit organizer action only. Inside ONE transaction holding the per-Group
 * advisory lock (one lock for all of a Group's scopes — a replacement may touch two): an existing
 * ACTIVE pick for the Match is returned unchanged (idempotent: repeats, double clicks, retries);
 * otherwise the pool = confirmed attendees not yet selected this cycle, sorted by id, and one is
 * chosen with crypto.randomInt (uniform, cryptographically secure). Two partial unique indexes
 * enforce "one ACTIVE pick per Match" and "one counted pick per player per cycle of a scope" in
 * the database itself. Generate, Publish, page loads and Telegram (re)sends only READ the pick.
 *
 * REPLACEMENT (no reroll): allowed only when the selected player is no longer a confirmed attendee,
 * and all-or-nothing (if nobody can be drawn, nothing changes and the original pick stays).
 *   - pick from its scope's CURRENT cycle → RELEASED: the player gets their turn back in that same
 *     cycle, so one Match never consumes two slots of a cycle;
 *   - pick from an already-CLOSED cycle → REPLACED: it stops being the Match's Spotlight but still
 *     counts as that player's turn in its own cycle — a closed cycle's history is never rewritten.
 * (The pick's OWN recorded scope decides — e.g. a whole-Group pick made before this Match's
 * Community had its own rotation.) The new player is drawn from the Match's CURRENT scope and
 * cycle by the same rule; the organizer's text is kept.
 * "Selected in cycle N" = ACTIVE or REPLACED picks of cycle N in the scope (the partial unique
 * index enforces at most one per player per cycle per scope).
 */

export const SPOTLIGHT_NOTE_MAX = 200;
export { SPOTLIGHT_TITLE } from "@/lib/messaging/content";

type Tx = Prisma.TransactionClient;
/** Rotation scope: a Community of the Group, or communityId null = the whole Group. */
type Scope = { groupId: string; communityId: string | null };

export type SpotlightProgress = { cycle: number; selected: number; roster: number; complete: boolean };
export type SpotlightView = {
  /** The rotation this Match uses: its Community's own (name), or the whole Group (null). */
  rotation: { communityName: string | null };
  pick: {
    playerId: string;
    playerName: string;
    note: string | null;
    cycle: number;
    selectedAt: string;
    /** Drawn in another scope (e.g. the whole-Group rotation, before this Community had its own). */
    otherRotation: boolean;
    /** The scope it was drawn in: a Community's name, or null = the whole-Group rotation. */
    rotationName: string | null;
  } | null;
  /** The selected player is still a confirmed attendee of this Match. */
  stillAttending: boolean;
  confirmedCount: number;
  /** Confirmed attendees not yet selected this cycle (who could be drawn now). */
  poolSize: number;
  progress: SpotlightProgress;
};

export type SpotlightOutcome =
  | { ok: true; view: SpotlightView; created: boolean }
  | { ok: false; code: "NOT_FOUND" | "NO_CONFIRMED" | "ALL_ATTENDEES_SELECTED" | "STILL_ATTENDING" | "NO_PICK"; message: string; view?: SpotlightView };

/** Plain text, one line, ≤ SPOTLIGHT_NOTE_MAX characters (code points); blank → null. Escaped only when rendered. */
export function normalizeSpotlightNote(v: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: true, note: null };
  if (typeof v !== "string") return { ok: false, error: "The text must be plain text." };
  // Line breaks / tabs → spaces; other control and invisible-formatting characters are dropped.
  const cleaned = v
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!cleaned) return { ok: true, note: null };
  if ([...cleaned].length > SPOTLIGHT_NOTE_MAX) return { ok: false, error: `Keep the text to ${SPOTLIGHT_NOTE_MAX} characters or fewer.` };
  return { ok: true, note: cleaned };
}

/** Uniform, cryptographically secure choice; the pool is sorted first so only the draw decides. */
export function drawFromPool(pool: readonly string[], rand: (max: number) => number = randomInt): string | null {
  if (pool.length === 0) return null;
  const sorted = [...new Set(pool)].sort();
  return sorted[rand(sorted.length)] ?? null;
}

/** Cycle state from the active roster and who is selected (pure; see the policy above). */
export function cycleState(activeRoster: readonly string[], selectedThisCycle: ReadonlySet<string>) {
  const roster = [...new Set(activeRoster)];
  const selected = roster.filter((id) => selectedThisCycle.has(id)).length;
  return { roster: roster.length, selected, complete: roster.length > 0 && selected === roster.length };
}

async function lockGroup(tx: Tx, groupId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"spotlight:" + groupId}))`;
}

/** The Match's rotation scope, from the authoritative Match → Community association. null = no such Match. */
async function matchScope(tx: Tx, groupId: string, matchId: string): Promise<(Scope & { communityName: string | null }) | null> {
  const match = await tx.match.findFirst({ where: { id: matchId, groupId }, select: { communityId: true } });
  if (!match) return null;
  const community = await resolveCommunity(groupId, match.communityId, tx);
  return { groupId, communityId: community?.id ?? null, communityName: community?.name ?? null };
}

/** The scope's current cycle, creating its rotation row at cycle 1 on first use. */
async function rotationCycle(tx: Tx, scope: Scope): Promise<number> {
  if (scope.communityId) {
    const row = await tx.spotlightCommunityRotation.upsert({ where: { communityId: scope.communityId }, update: {}, create: { communityId: scope.communityId, groupId: scope.groupId }, select: { cycle: true } });
    return row.cycle;
  }
  const row = await tx.spotlightRotation.upsert({ where: { groupId: scope.groupId }, update: {}, create: { groupId: scope.groupId }, select: { cycle: true } });
  return row.cycle;
}

/** The scope's current cycle without writing anything (1 before its first pick). */
async function readCycle(tx: Tx, scope: Scope): Promise<number> {
  const row = scope.communityId
    ? await tx.spotlightCommunityRotation.findFirst({ where: { communityId: scope.communityId, groupId: scope.groupId }, select: { cycle: true } })
    : await tx.spotlightRotation.findUnique({ where: { groupId: scope.groupId }, select: { cycle: true } });
  return row?.cycle ?? 1;
}

async function setCycle(tx: Tx, scope: Scope, cycle: number) {
  if (scope.communityId) await tx.spotlightCommunityRotation.update({ where: { communityId: scope.communityId }, data: { cycle } });
  else await tx.spotlightRotation.update({ where: { groupId: scope.groupId }, data: { cycle } });
}

async function selectedIn(tx: Tx, scope: Scope, cycle: number): Promise<Set<string>> {
  const picks = await tx.spotlightPick.findMany({ where: { groupId: scope.groupId, communityId: scope.communityId, cycle, status: { in: ["ACTIVE", "REPLACED"] } }, select: { playerId: true } });
  return new Set(picks.map((p) => p.playerId));
}

/** The scope's rotation roster — the same eligible roster the attendance counts use. */
async function rosterIds(tx: Tx, scope: Scope): Promise<string[]> {
  return (await eligibleRosterIds(scope.groupId, scope.communityId, tx)).ids;
}

async function buildView(tx: Tx, scope: Scope & { communityName: string | null }, matchId: string, confirmed: string[]): Promise<SpotlightView> {
  const cycle = await readCycle(tx, scope);
  const selected = await selectedIn(tx, scope, cycle);
  const state = cycleState(await rosterIds(tx, scope), selected);
  const pick = await tx.spotlightPick.findFirst({ where: { matchId, groupId: scope.groupId, status: "ACTIVE" }, select: { playerId: true, playerName: true, note: true, cycle: true, createdAt: true, communityId: true, community: { select: { name: true } } } });
  // When the cycle is complete, the next draw starts a fresh cycle — so everyone attending is eligible.
  const poolSize = state.complete ? confirmed.length : confirmed.filter((id) => !selected.has(id)).length;
  return {
    rotation: { communityName: scope.communityName },
    pick: pick
      ? { playerId: pick.playerId, playerName: pick.playerName, note: pick.note, cycle: pick.cycle, selectedAt: pick.createdAt.toISOString(), otherRotation: pick.communityId !== scope.communityId, rotationName: pick.community?.name ?? null }
      : null,
    stillAttending: pick ? confirmed.includes(pick.playerId) : false,
    confirmedCount: confirmed.length,
    poolSize,
    progress: { cycle, ...state },
  };
}

/** Read-only state for the workspace (never selects). One read-only transaction = one connection. */
export async function spotlightView(groupId: string, matchId: string): Promise<SpotlightView | null> {
  return prisma.$transaction(async (tx) => {
    const scope = await matchScope(tx, groupId, matchId);
    if (!scope) return null;
    const confirmed = (await confirmedAttendeeIds(groupId, matchId, tx)) ?? [];
    return buildView(tx, scope, matchId, confirmed);
  });
}

/** Draw inside the locked transaction: returns the new pick's player id, or the reason nothing could be drawn. */
async function drawLocked(tx: Tx, scope: Scope, matchId: string, confirmed: string[], userId: string | null, note: string | null, rand?: (max: number) => number): Promise<{ ok: true } | { ok: false; code: "NO_CONFIRMED" | "ALL_ATTENDEES_SELECTED" }> {
  if (confirmed.length === 0) return { ok: false, code: "NO_CONFIRMED" };
  let cycle = await rotationCycle(tx, scope);
  let selected = await selectedIn(tx, scope, cycle);
  if (cycleState(await rosterIds(tx, scope), selected).complete) {
    // Everyone on this scope's roster has had a turn: start its next cycle (only now, never early).
    cycle += 1;
    await setCycle(tx, scope, cycle);
    selected = new Set();
  }
  const playerId = drawFromPool(confirmed.filter((id) => !selected.has(id)), rand);
  if (!playerId) return { ok: false, code: "ALL_ATTENDEES_SELECTED" };
  const player = await tx.player.findFirstOrThrow({ where: { id: playerId, groupId: scope.groupId }, select: { firstName: true, lastName: true } });
  await tx.spotlightPick.create({ data: { groupId: scope.groupId, communityId: scope.communityId, matchId, cycle, playerId, playerName: playerDisplayName(player), note, createdByUserId: userId } });
  return { ok: true };
}

const MESSAGES = {
  NO_CONFIRMED: "Nobody is confirmed as playing for this match yet, so there's no one to select.",
  ALL_ATTENDEES_SELECTED:
    "Everyone playing in this match has already been the Spotlight this cycle. The members still waiting for their turn aren't playing, so the cycle isn't restarted — the Spotlight is simply left out of this match.",
  STILL_ATTENDING: "The selected player is still playing in this match, so the Spotlight can't be redrawn (that keeps the rotation fair).",
  NO_PICK: "No Spotlight has been selected for this match yet.",
  NOT_FOUND: "Match not found",
} as const;

/**
 * Select (or, with replace, swap out an absent selection). Idempotent and serialized per Group.
 * `rand` is for tests only.
 */
/** Thrown inside the transaction to roll a replacement back when nobody can be drawn. */
class ReplacementAborted extends Error {
  constructor(readonly code: "NO_CONFIRMED" | "ALL_ATTENDEES_SELECTED") {
    super(code);
  }
}

export async function selectSpotlight(groupId: string, matchId: string, userId: string | null, opts: { replace?: boolean; rand?: (max: number) => number } = {}): Promise<SpotlightOutcome> {
  try {
    return await selectLocked(groupId, matchId, userId, opts);
  } catch (e) {
    if (!(e instanceof ReplacementAborted)) throw e;
    // Rolled back: the original pick is untouched.
    const view = await spotlightView(groupId, matchId);
    return { ok: false, code: e.code, message: MESSAGES[e.code], ...(view ? { view } : {}) };
  }
}

async function selectLocked(groupId: string, matchId: string, userId: string | null, opts: { replace?: boolean; rand?: (max: number) => number }): Promise<SpotlightOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const scope = await matchScope(tx, groupId, matchId);
    if (!scope) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
    // Attendance is read inside the lock, on THIS transaction's connection (a second pooled connection
    // here would deadlock under concurrency, or always with a pool of one).
    const confirmed = (await confirmedAttendeeIds(groupId, matchId, tx)) ?? [];
    const existing = await tx.spotlightPick.findFirst({ where: { matchId, groupId, status: "ACTIVE" }, select: { id: true, playerId: true, note: true, cycle: true, communityId: true } });

    if (!opts.replace) {
      if (existing) return { ok: true, created: false, view: await buildView(tx, scope, matchId, confirmed) };
      const drawn = await drawLocked(tx, scope, matchId, confirmed, userId, null, opts.rand);
      if (!drawn.ok) return { ok: false, code: drawn.code, message: MESSAGES[drawn.code], view: await buildView(tx, scope, matchId, confirmed) };
      return { ok: true, created: true, view: await buildView(tx, scope, matchId, confirmed) };
    }

    // Replacement: only for a selection whose player is no longer confirmed.
    if (!existing) return { ok: false, code: "NO_PICK", message: MESSAGES.NO_PICK };
    if (confirmed.includes(existing.playerId)) return { ok: false, code: "STILL_ATTENDING", message: MESSAGES.STILL_ATTENDING, view: await buildView(tx, scope, matchId, confirmed) };
    // Same (current) cycle OF THE PICK'S OWN SCOPE → give the absent player their turn back; an
    // older, closed cycle keeps its history (REPLACED still counts there). Either way the Match's
    // slot is freed first.
    const current = await readCycle(tx, { groupId, communityId: existing.communityId });
    await tx.spotlightPick.update({ where: { id: existing.id }, data: { status: existing.cycle === current ? "RELEASED" : "REPLACED", releasedAt: new Date() } });
    const drawn = await drawLocked(tx, scope, matchId, confirmed, userId, existing.note, opts.rand);
    if (!drawn.ok) throw new ReplacementAborted(drawn.code); // all-or-nothing: roll back, keep the original pick
    return { ok: true, created: true, view: await buildView(tx, scope, matchId, confirmed) };
  });
}

/** Save the organizer's text on the Match's current Spotlight. */
export async function updateSpotlightNote(groupId: string, matchId: string, note: string | null): Promise<SpotlightOutcome> {
  const updated = await prisma.spotlightPick.updateMany({ where: { matchId, groupId, status: "ACTIVE" }, data: { note } });
  const view = await spotlightView(groupId, matchId);
  if (!view) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
  if (updated.count === 0) return { ok: false, code: "NO_PICK", message: MESSAGES.NO_PICK, view };
  return { ok: true, created: false, view };
}

/** What the Telegram teams message shows — the SAVED pick only (never draws). null = no section. */
export async function spotlightForMessage(groupId: string, matchId: string | null): Promise<{ name: string; note: string | null } | null> {
  if (!matchId) return null;
  const pick = await prisma.spotlightPick.findFirst({ where: { matchId, groupId, status: "ACTIVE" }, select: { playerName: true, note: true } });
  return pick ? { name: pick.playerName, note: pick.note } : null;
}
