import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { confirmedAttendeeIds } from "@/lib/attendanceSnapshot";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * Random Player Spotlight — one confirmed attendee per Match, chosen fairly at random, never the
 * same person twice in a rotation cycle.
 *
 * CYCLE MEMBERSHIP POLICY (per Group):
 *   - The rotation roster is the Group's ACTIVE players, evaluated at selection time.
 *   - A player is "selected in cycle N" when they have an ACTIVE pick in cycle N.
 *   - Cycle N is complete when every currently ACTIVE player has been selected in it. Newly added
 *     players join the current cycle (unselected); deactivated players stop counting toward
 *     completion (so the cycle can always finish) and, if reactivated, keep whatever status they
 *     had in the cycle; deleted players disappear with their picks.
 *   - The next cycle starts only at the first selection after the current one is complete — never
 *     early. Absent players simply stay unselected for a later match.
 *   - If every CONFIRMED attendee of this Match was already selected this cycle while other members
 *     are still waiting (but aren't attending), nothing is selected and nothing restarts: the
 *     organizer is told, and the Spotlight is simply left out of this Match.
 *
 * SELECTION: explicit organizer action only. Inside ONE transaction holding a per-Group advisory
 * lock: an existing ACTIVE pick for the Match is returned unchanged (idempotent: repeats, double
 * clicks, retries); otherwise the pool = confirmed attendees not yet selected this cycle, sorted by
 * id, and one is chosen with crypto.randomInt (uniform, cryptographically secure). Two partial
 * unique indexes enforce "one ACTIVE pick per Match" and "one ACTIVE pick per player per cycle"
 * in the database itself. Generate, Publish, page loads and Telegram (re)sends only READ the pick.
 *
 * REPLACEMENT (no reroll): allowed only when the selected player is no longer a confirmed attendee.
 * Their pick is RELEASED — they get their turn back, so one Match never consumes two slots — and
 * a new player is drawn by the same rule. The organizer's text is kept.
 */

export const SPOTLIGHT_NOTE_MAX = 200;
export { SPOTLIGHT_TITLE } from "@/lib/messaging/content";

type Tx = Prisma.TransactionClient;

export type SpotlightProgress = { cycle: number; selected: number; roster: number; complete: boolean };
export type SpotlightView = {
  pick: { playerId: string; playerName: string; note: string | null; cycle: number; selectedAt: string } | null;
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

async function rotationCycle(tx: Tx, groupId: string): Promise<number> {
  const row = await tx.spotlightRotation.upsert({ where: { groupId }, update: {}, create: { groupId }, select: { cycle: true } });
  return row.cycle;
}

async function selectedIn(tx: Tx, groupId: string, cycle: number): Promise<Set<string>> {
  const picks = await tx.spotlightPick.findMany({ where: { groupId, cycle, status: "ACTIVE" }, select: { playerId: true } });
  return new Set(picks.map((p) => p.playerId));
}

async function activeRosterIds(tx: Tx, groupId: string): Promise<string[]> {
  return (await tx.player.findMany({ where: { groupId, isActive: true }, select: { id: true } })).map((p) => p.id);
}

async function buildView(tx: Tx, groupId: string, matchId: string, confirmed: string[]): Promise<SpotlightView> {
  const cycle = (await tx.spotlightRotation.findUnique({ where: { groupId }, select: { cycle: true } }))?.cycle ?? 1;
  const selected = await selectedIn(tx, groupId, cycle);
  const state = cycleState(await activeRosterIds(tx, groupId), selected);
  const pick = await tx.spotlightPick.findFirst({ where: { matchId, groupId, status: "ACTIVE" }, select: { playerId: true, playerName: true, note: true, cycle: true, createdAt: true } });
  // When the cycle is complete, the next draw starts a fresh cycle — so everyone attending is eligible.
  const poolSize = state.complete ? confirmed.length : confirmed.filter((id) => !selected.has(id)).length;
  return {
    pick: pick ? { playerId: pick.playerId, playerName: pick.playerName, note: pick.note, cycle: pick.cycle, selectedAt: pick.createdAt.toISOString() } : null,
    stillAttending: pick ? confirmed.includes(pick.playerId) : false,
    confirmedCount: confirmed.length,
    poolSize,
    progress: { cycle, ...state },
  };
}

/** Read-only state for the workspace (never selects). */
export async function spotlightView(groupId: string, matchId: string): Promise<SpotlightView | null> {
  const confirmed = await confirmedAttendeeIds(groupId, matchId);
  if (!confirmed) return null;
  return buildView(prisma, groupId, matchId, confirmed);
}

/** Draw inside the locked transaction: returns the new pick's player id, or the reason nothing could be drawn. */
async function drawLocked(tx: Tx, groupId: string, matchId: string, confirmed: string[], userId: string | null, note: string | null, rand?: (max: number) => number): Promise<{ ok: true } | { ok: false; code: "NO_CONFIRMED" | "ALL_ATTENDEES_SELECTED" }> {
  if (confirmed.length === 0) return { ok: false, code: "NO_CONFIRMED" };
  let cycle = await rotationCycle(tx, groupId);
  let selected = await selectedIn(tx, groupId, cycle);
  if (cycleState(await activeRosterIds(tx, groupId), selected).complete) {
    // Everyone active has had a turn: start the next cycle (only now, never early).
    cycle += 1;
    await tx.spotlightRotation.update({ where: { groupId }, data: { cycle } });
    selected = new Set();
  }
  const playerId = drawFromPool(confirmed.filter((id) => !selected.has(id)), rand);
  if (!playerId) return { ok: false, code: "ALL_ATTENDEES_SELECTED" };
  const player = await tx.player.findFirstOrThrow({ where: { id: playerId, groupId }, select: { firstName: true, lastName: true } });
  await tx.spotlightPick.create({ data: { groupId, matchId, cycle, playerId, playerName: playerDisplayName(player), note, createdByUserId: userId } });
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
export async function selectSpotlight(groupId: string, matchId: string, userId: string | null, opts: { replace?: boolean; rand?: (max: number) => number } = {}): Promise<SpotlightOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const match = await tx.match.findFirst({ where: { id: matchId, groupId }, select: { id: true } });
    if (!match) return { ok: false, code: "NOT_FOUND", message: MESSAGES.NOT_FOUND };
    // Attendance is read inside the lock, so a concurrent request sees the same state.
    const confirmed = (await confirmedAttendeeIds(groupId, matchId)) ?? [];
    const existing = await tx.spotlightPick.findFirst({ where: { matchId, groupId, status: "ACTIVE" }, select: { id: true, playerId: true, note: true } });

    if (!opts.replace) {
      if (existing) return { ok: true, created: false, view: await buildView(tx, groupId, matchId, confirmed) };
      const drawn = await drawLocked(tx, groupId, matchId, confirmed, userId, null, opts.rand);
      if (!drawn.ok) return { ok: false, code: drawn.code, message: MESSAGES[drawn.code], view: await buildView(tx, groupId, matchId, confirmed) };
      return { ok: true, created: true, view: await buildView(tx, groupId, matchId, confirmed) };
    }

    // Replacement: only for a selection whose player is no longer confirmed.
    if (!existing) return { ok: false, code: "NO_PICK", message: MESSAGES.NO_PICK };
    if (confirmed.includes(existing.playerId)) return { ok: false, code: "STILL_ATTENDING", message: MESSAGES.STILL_ATTENDING, view: await buildView(tx, groupId, matchId, confirmed) };
    // Give the absent player their turn back first (one Match never consumes two slots).
    await tx.spotlightPick.update({ where: { id: existing.id }, data: { status: "RELEASED", releasedAt: new Date() } });
    const drawn = await drawLocked(tx, groupId, matchId, confirmed, userId, existing.note, opts.rand);
    if (!drawn.ok) return { ok: false, code: drawn.code, message: MESSAGES[drawn.code], view: await buildView(tx, groupId, matchId, confirmed) };
    return { ok: true, created: true, view: await buildView(tx, groupId, matchId, confirmed) };
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
