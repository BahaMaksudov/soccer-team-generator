/**
 * Regression — Random Player Spotlight under a ONE-connection pool (Vercel/Neon worst case).
 * Selection holds a per-Group advisory lock inside one interactive transaction; every read in
 * it (match, community, roster, attendance, picks) must use THAT transaction's connection. A
 * single read through the global client would need a second connection and wait forever for
 * the one the transaction holds ("Timed out fetching a new connection"). The read-only view is
 * one transaction too. Community and whole-Group scopes are exercised side by side.
 *
 * REAL DATABASE (guarded local test DB only). No network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const base = process.env.DATABASE_URL!;
  const url = `${base}${base.includes("?") ? "&" : "?"}connection_limit=1&pool_timeout=5`;
  return { prisma: new PrismaClient({ datasources: { db: { url } } }) };
});

import { prisma } from "@/lib/prisma";
import { selectSpotlight, spotlightView } from "@/lib/spotlight";

const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6"];

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "SpotlightPick","SpotlightRotation","SpotlightCommunityRotation","CommunityPlayer","Community","AttendanceResponse","Match","Player","Group","Organization" RESTART IDENTITY CASCADE`
  );
  await prisma.organization.create({ data: { id: "o", name: "O", slug: "o", plan: "LEGACY" } });
  await prisma.group.create({ data: { id: "g", organizationId: "o", name: "G", slug: "g", sportKey: "soccer", timezone: "UTC" } });
  for (const id of PLAYERS) await prisma.player.create({ data: { id, groupId: "g", firstName: id, lastName: "X", position: "FORWARD", rating: "GOOD", stamina: 3 } });
  await prisma.community.create({ data: { id: "c-fun", groupId: "g", name: "FunnyStuff" } });
  await prisma.community.create({ data: { id: "c-fc", groupId: "g", name: "UCCNE - FC" } });
  for (const playerId of ["p1", "p2", "p3", "p4"]) await prisma.communityPlayer.create({ data: { groupId: "g", communityId: "c-fun", playerId } });
  for (const playerId of ["p3", "p4", "p5", "p6"]) await prisma.communityPlayer.create({ data: { groupId: "g", communityId: "c-fc", playerId } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function matchWith(id: string, communityId: string | null, playing: string[]) {
  await prisma.match.create({ data: { id, groupId: "g", communityId, date: new Date("2026-11-20T00:00:00Z") } });
  for (const playerId of playing) {
    await prisma.attendanceResponse.create({ data: { matchId: id, groupId: "g", playerId, participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } });
  }
}

describe("Spotlight with connection_limit=1", () => {
  it("concurrent selections and views across community and whole-group scopes all complete", async () => {
    await matchWith("fun", "c-fun", ["p1", "p2", "p3", "p4"]);
    await matchWith("fc", "c-fc", ["p3", "p4", "p5", "p6"]);
    await matchWith("wg", null, PLAYERS);
    const work = [
      ...Array.from({ length: 3 }, () => selectSpotlight("g", "fun", null)),
      ...Array.from({ length: 3 }, () => selectSpotlight("g", "fc", null)),
      ...Array.from({ length: 3 }, () => selectSpotlight("g", "wg", null)),
      spotlightView("g", "fun"),
      spotlightView("g", "fc"),
      spotlightView("g", "wg"),
    ];
    const results = await Promise.all(work);
    expect(results.slice(0, 9).every((r) => r && "ok" in r && r.ok)).toBe(true);
    const picks = await prisma.spotlightPick.findMany({ orderBy: { matchId: "asc" }, select: { matchId: true, communityId: true, status: true } });
    expect(picks).toEqual([
      { matchId: "fc", communityId: "c-fc", status: "ACTIVE" },
      { matchId: "fun", communityId: "c-fun", status: "ACTIVE" },
      { matchId: "wg", communityId: null, status: "ACTIVE" },
    ]);
    const view = await spotlightView("g", "fun");
    expect(view?.progress).toEqual({ cycle: 1, selected: 1, roster: 4, complete: false });
  }, 30_000);
});
