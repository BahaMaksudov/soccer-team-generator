/**
 * Phase 2D.6E.6C — REAL-DATABASE tenant-isolation tests.
 *
 * Runs only via `npm run test:integration` against a guarded local TEST
 * database (see testDatabaseGuard.ts). Uses the real canonical route
 * handlers, the real Prisma client, and the real URL-bound tenant
 * resolver (only the NextAuth session lookup is mocked). Telegram is
 * mocked: global.fetch throws and is counted — no real Telegram call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const ADMIN_EMAIL = "itest-admin@example.test";
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { email: ADMIN_EMAIL } })) }));
vi.mock("@/lib/authOptions", () => ({ authOptions: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as teamNameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/team-name/route";
import * as chatsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/chats/route";
import * as pollsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/polls/route";
import * as usersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";
import * as importRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/import/route";
import * as linkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/link/route";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";

const ORG = "itest-org";
const A = "grp-a";
const B = "grp-b";
const DAY = new Date("2026-09-23T00:00:00.000Z");
const teams = (ids: string[]) =>
  JSON.stringify([{ teamNumber: 1, players: ids.map((id) => ({ id, firstName: id, lastName: "X", position: "DEFENDER" })) }]);

const params = (groupSlug: string, extra: Record<string, string> = {}, organizationSlug = ORG) => ({
  params: Promise.resolve({ organizationSlug, groupSlug, ...extra }),
});
const playerParams = (groupSlug: string, id: string) => ({
  params: Promise.resolve({ organizationSlug: ORG, groupSlug, id }),
});
const json = (method: string, body: unknown, url = "http://itest.local/") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Every network call is treated as a (forbidden) Telegram call: it
// throws, and a suite-wide counter (never reset) is asserted to be 0.
let totalTelegramCalls = 0;
const telegramFetch = vi.fn(async () => {
  totalTelegramCalls++;
  throw new Error("real Telegram API must never be called in integration tests");
});

async function snapshotGroupA() {
  return JSON.stringify({
    players: await prisma.player.findMany({ where: { groupId: A }, orderBy: { id: "asc" } }),
    gens: await prisma.teamGeneration.findMany({ where: { groupId: A }, orderBy: { id: "asc" } }),
    settings: await prisma.groupSetting.findMany({ where: { groupId: A }, orderBy: { id: "asc" } }),
    polls: await prisma.telegramPoll.findMany({ where: { groupId: A }, orderBy: { pollId: "asc" } }),
    links: await prisma.telegramUserLink.findMany({ where: { groupId: A }, orderBy: { id: "asc" } }),
    chats: await prisma.telegramChat.findMany({ where: { groupId: A }, orderBy: { id: "asc" } }),
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const user = await prisma.user.create({ data: { email: ADMIN_EMAIL, passwordHash: "x", name: "ITest" } });
  const org = await prisma.organization.create({ data: { id: "org-itest", name: "ITest Org", slug: ORG } });
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.id, role: "OWNER" } });
  for (const id of [A, B]) {
    await prisma.group.create({ data: { id, organizationId: org.id, name: id, slug: id, sportKey: "soccer", timezone: "America/New_York" } });
    await prisma.groupSetting.create({ data: { groupId: id, key: "teamName", value: `Team ${id}` } });
  }
  const player = (id: string, groupId: string) =>
    prisma.player.create({ data: { id, groupId, firstName: id, lastName: "X", position: "DEFENDER", rating: "GOOD", stamina: 3 } });
  await player("a1", A);
  await player("a2", A);
  await player("b1", B);
  await player("b2", B);

  await prisma.telegramChat.create({ data: { chatId: 1001n, title: "Group A Chat", groupId: A } });
  await prisma.telegramPoll.create({
    data: { pollId: "poll-a", chatId: 1001n, messageId: 5n, question: "Who is playing on 9/23/26?", optionsJson: "[]", pollDate: DAY, groupId: A },
  });
  await prisma.telegramPollAnswer.create({ data: { pollId: "poll-a", userId: 777n, optionIdsJson: "[0]", groupId: A } });
  await prisma.telegramUserLink.create({ data: { userId: 777n, playerId: "a1", groupId: A } });

  await prisma.teamGeneration.create({ data: { id: "gen-a", groupId: A, date: DAY, teamsJson: teams(["a1", "a2"]) } });
  await prisma.teamGeneration.create({ data: { id: "gen-b", groupId: B, date: DAY, teamsJson: teams(["b1", "b2"]) } });
}

const originalFetch = global.fetch;

beforeAll(async () => {
  // Belt and braces: the connected database must be the guarded test database.
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
});

beforeEach(async () => {
  await seed();
  telegramFetch.mockClear();
  global.fetch = telegramFetch as unknown as typeof fetch;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
});

describe("real-DB tenant isolation: Group B URL vs Group A resources", () => {
  it("1. Group B cannot PATCH a Group A player", async () => {
    const before = await snapshotGroupA();
    const res = await playerRoute.PATCH(json("PATCH", { firstName: "Hacked", stamina: 1 }), playerParams(B, "a1"));
    expect(res.status).toBe(404);
    expect(await snapshotGroupA()).toBe(before);
  });

  it("2. Group B cannot DELETE a Group A player", async () => {
    const res = await playerRoute.DELETE(new Request("http://itest.local/"), playerParams(B, "a1"));
    expect(res.status).toBe(404);
    expect(await prisma.player.findUnique({ where: { id: "a1" } })).not.toBeNull();
  });

  it("2b. the foreign Group A player row is byte-identical after both attempts; Group B's own PATCH/DELETE still work", async () => {
    const a1Before = await prisma.player.findUnique({ where: { id: "a1" } });
    await playerRoute.PATCH(json("PATCH", { firstName: "Hacked", isActive: false }), playerParams(B, "a1"));
    await playerRoute.DELETE(new Request("http://itest.local/"), playerParams(B, "a1"));
    expect(await prisma.player.findUnique({ where: { id: "a1" } })).toEqual(a1Before);

    const own = await playerRoute.PATCH(json("PATCH", { stamina: 5 }), playerParams(B, "b1"));
    expect(own.status).toBe(200);
    expect((await prisma.player.findUnique({ where: { id: "b1" } }))!.stamina).toBe(5);
    const del = await playerRoute.DELETE(new Request("http://itest.local/"), playerParams(B, "b2"));
    expect(del.status).toBe(200);
    expect(await prisma.player.findUnique({ where: { id: "b2" } })).toBeNull();
    expect(await prisma.player.findUnique({ where: { id: "a1" } })).toEqual(a1Before);
  });

  it("3. Generate rejects Group A ids and mixed Group A + Group B ids", async () => {
    const only = await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ["a1"] }), params(B));
    const mixed = await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ["b1", "a1"] }), params(B));
    expect(only.status).toBe(400);
    expect(mixed.status).toBe(400);
    expect(await mixed.text()).not.toContain("a1");
  });

  it("4. a Group B settings write changes only Group B", async () => {
    const before = await snapshotGroupA();
    const res = await teamNameRoute.PUT(json("PUT", { teamName: "Renamed B", groupId: A, organizationId: "org-itest" }), params(B));
    expect(res.status).toBe(200);
    expect((await prisma.groupSetting.findFirst({ where: { groupId: B, key: "teamName" } }))!.value).toBe("Renamed B");
    expect(await snapshotGroupA()).toBe(before);
  });

  it("5. Group B Telegram reads return only Group B (empty) — while Group A really has data", async () => {
    // Non-vacuous: the same reads through Group A's URL DO return Group A data.
    expect((await (await chatsRoute.GET(new Request("http://itest.local/"), params(A))).json()).chats).toHaveLength(1);
    expect((await (await pollsRoute.GET(new Request("http://itest.local/?includeClosed=1"), params(A))).json()).polls).toHaveLength(1);

    expect(await (await chatsRoute.GET(new Request("http://itest.local/"), params(B))).json()).toEqual({ chats: [] });
    expect(await (await pollsRoute.GET(new Request("http://itest.local/?includeClosed=1"), params(B))).json()).toEqual({ polls: [] });
    expect(await (await usersRoute.GET(new Request("http://itest.local/"), params(B))).json()).toEqual([]);
  });

  it("6. Import rejects a Group A poll", async () => {
    const res = await importRoute.POST(json("POST", { pollId: "poll-a" }), params(B));
    expect(res.status).toBe(404);
  });

  it("7. Link refuses a Telegram user linked in Group A, generically and without reassignment", async () => {
    const before = await snapshotGroupA();
    const res = await linkRoute.POST(json("POST", { userId: "777", playerId: "b1" }), params(B));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "This Telegram user cannot be linked." }));
    expect(text).not.toMatch(/grp-a|a1|elsewhere|ITest Org|org-itest/);
    expect(await snapshotGroupA()).toBe(before);
    expect(await prisma.telegramUserLink.count({ where: { groupId: B } })).toBe(0);
  });

  it("8. Close/Post rejects a Group A poll before any Telegram call", async () => {
    const before = await snapshotGroupA();
    const res = await closePostRoute.POST(json("POST", { pollId: "poll-a", teamGenerationId: "gen-a" }), params(B));
    expect(res.status).toBe(404);
    expect(telegramFetch).not.toHaveBeenCalled();
    expect(await snapshotGroupA()).toBe(before);
  });

  it("9a. Publish rejects Group A-only player content without writing", async () => {
    const before = await snapshotGroupA();
    const bBefore = await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } });
    const res = await publishRoute.POST(json("POST", { date: "2026-10-12", teams: JSON.parse(teams(["a1", "a2"])) }), params(B));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/a1|a2|grp-a/);
    expect(await prisma.teamGeneration.count({ where: { groupId: B } })).toBe(1);
    expect(await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } })).toEqual(bBefore);
    expect(await snapshotGroupA()).toBe(before);
  });

  it("9b. Publish rejects mixed Group A + Group B content without writing", async () => {
    const before = await snapshotGroupA();
    const bBefore = await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } });
    const res = await publishRoute.POST(json("POST", { date: "2026-09-23", teams: JSON.parse(teams(["b1", "a1"])) }), params(B));
    expect(res.status).toBe(400);
    expect(await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } })).toEqual(bBefore);
    expect(await snapshotGroupA()).toBe(before);
  });

  it("10. same-date Group B Publish cannot overwrite Group A", async () => {
    const before = await snapshotGroupA();
    const res = await publishRoute.POST(json("POST", { date: "2026-09-23", teams: JSON.parse(teams(["b2", "b1"])) }), params(B));
    expect(res.status).toBe(200);
    expect(JSON.parse((await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } }))!.teamsJson)[0].players[0].id).toBe("b2");
    expect(await snapshotGroupA()).toBe(before);
  });

  it("11. same-date Group B Delete cannot delete Group A", async () => {
    const before = await snapshotGroupA();
    const res = await publishRoute.DELETE(new Request("http://itest.local/?date=2026-09-23"), params(B));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);
    expect(await prisma.teamGeneration.findUnique({ where: { id: "gen-b" } })).toBeNull();
    expect(await snapshotGroupA()).toBe(before);
  });

  it("12. an unknown Organization → 404", async () => {
    const res = await chatsRoute.GET(new Request("http://itest.local/"), params(A, {}, "no-such-org"));
    expect(res.status).toBe(404);
  });

  it("13. an unknown Group → 404", async () => {
    const res = await chatsRoute.GET(new Request("http://itest.local/"), params("no-such-group"));
    expect(res.status).toBe(404);
  });

  it("15. Publish stores the authoritative DB snapshot, not forged client fields, and it stays fixed afterwards", async () => {
    const before = await snapshotGroupA();
    // Authoritative values for b1 (seeded): firstName "b1", lastName "X", DEFENDER, GOOD, stamina 3.
    const forged = [
      {
        teamNumber: 1,
        injectedTeamKey: "bad",
        players: [
          { id: "b2", firstName: "FORGED", lastName: "PLAYER", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 999, someInjectedKey: "bad" },
          { id: "b1", firstName: "Also", lastName: "Forged" },
        ],
      },
    ];
    const res = await publishRoute.POST(json("POST", { date: "2026-10-19", teams: forged }), params(B));
    expect(res.status).toBe(200);

    const row = await prisma.teamGeneration.findFirst({ where: { groupId: B, date: new Date("2026-10-19T00:00:00.000Z") } });
    const snapshot = JSON.parse(row!.teamsJson);
    expect(snapshot).toEqual([
      {
        teamNumber: 1,
        players: [
          { id: "b2", firstName: "b2", lastName: "X", position: "DEFENDER", rating: "GOOD", stamina: 3 },
          { id: "b1", firstName: "b1", lastName: "X", position: "DEFENDER", rating: "GOOD", stamina: 3 },
        ],
      },
    ]);
    expect(row!.teamsJson).not.toMatch(/FORGED|PLAYER|Forged|999|EXCELLENT|someInjectedKey|injectedTeamKey|bad/);

    // Later edit to the Player row does NOT change the published snapshot.
    const edit = await playerRoute.PATCH(json("PATCH", { firstName: "Renamed", stamina: 5 }), playerParams(B, "b2"));
    expect(edit.status).toBe(200);
    const after = await prisma.teamGeneration.findUnique({ where: { id: row!.id } });
    expect(after!.teamsJson).toBe(row!.teamsJson);
    expect(after!.updatedAt).toEqual(row!.updatedAt);

    expect(await snapshotGroupA()).toBe(before);
  });

  it("14. no Telegram network call happened anywhere in this suite", () => {
    expect(totalTelegramCalls).toBe(0);
  });
});
