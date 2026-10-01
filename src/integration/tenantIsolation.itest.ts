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
    `TRUNCATE "TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  // Verified, as migration #13 makes every pre-existing OWNER.
  const user = await prisma.user.create({ data: { email: ADMIN_EMAIL, passwordHash: "x", name: "ITest", emailVerifiedAt: new Date() } });
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

  it("7. (M6-C) Group B links a Telegram user who is also linked in Group A — Group A is never read into the response or changed", async () => {
    const before = await snapshotGroupA();
    const res = await linkRoute.POST(json("POST", { userId: "777", playerId: "b1" }), params(B));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/grp-a|a1|elsewhere|ITest Org|org-itest/);
    expect(await snapshotGroupA()).toBe(before); // no reassignment of Group A's link
    expect(await prisma.telegramUserLink.findMany({ where: { userId: 777n }, select: { groupId: true, playerId: true }, orderBy: { groupId: "asc" } })).toEqual([
      { groupId: A, playerId: "a1" },
      { groupId: B, playerId: "b1" },
    ]);
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

// ---------------------------------------------------------------------------
// Phase 2D.7 — the DATABASE itself enforces tenant ownership (groupId NOT NULL).
// These use raw SQL on purpose: they bypass the application, its tenant
// checks and Prisma's generated types, so only PostgreSQL can reject them.
// ---------------------------------------------------------------------------
const TENANT_TABLES = ["Player", "TeamGeneration", "TelegramChat", "TelegramPoll", "TelegramPollAnswer", "TelegramUserLink"] as const;

/** Minimal valid INSERT for each table; `$G` is replaced by the groupId SQL literal. */
const INSERTS: Record<(typeof TENANT_TABLES)[number], string> = {
  Player: `INSERT INTO "Player" (id, "firstName", "lastName", position, rating, "updatedAt", "groupId") VALUES ('p-2d7', 'N', 'N', 'DEFENDER', 'GOOD', now(), $G)`,
  TeamGeneration: `INSERT INTO "TeamGeneration" (id, date, "teamsJson", "updatedAt", "groupId") VALUES ('g-2d7', '2027-01-04', '[]', now(), $G)`,
  TelegramChat: `INSERT INTO "TelegramChat" ("chatId", title, "updatedAt", "groupId") VALUES (4242, 'c', now(), $G)`,
  TelegramPoll: `INSERT INTO "TelegramPoll" ("pollId", "chatId", question, "optionsJson", "updatedAt", "groupId") VALUES ('poll-2d7', 1001, 'q', '[]', now(), $G)`,
  TelegramPollAnswer: `INSERT INTO "TelegramPollAnswer" (id, "pollId", "userId", "optionIdsJson", "updatedAt", "groupId") VALUES ('ans-2d7', 'poll-a', 4343, '[0]', now(), $G)`,
  TelegramUserLink: `INSERT INTO "TelegramUserLink" (id, "userId", "playerId", "updatedAt", "groupId") VALUES ('link-2d7', 4444, 'a2', now(), $G)`,
};

async function pgErrorCode(sql: string): Promise<{ code?: string } | null> {
  try {
    await prisma.$executeRawUnsafe(sql);
    return null;
  } catch (e) {
    const err = e as { meta?: { code?: string; message?: string }; message?: string };
    const msg = `${err.meta?.message ?? ""} ${err.message ?? ""}`;
    const code = err.meta?.code ?? (msg.match(/\b(23\d{3})\b/) || [])[1];
    return { code };
  }
}

/** Runs the INSERT in a PL/pgSQL block and returns the column named by a not_null_violation (nothing is kept). */
async function notNullViolationColumn(insertSql: string): Promise<string | null> {
  const block = `DO $blk$ DECLARE col text; BEGIN ${insertSql}; RAISE EXCEPTION 'ACCEPTED'; EXCEPTION WHEN not_null_violation THEN GET STACKED DIAGNOSTICS col = COLUMN_NAME; RAISE EXCEPTION 'NN:%', col; END $blk$`;
  try {
    await prisma.$executeRawUnsafe(block);
    return null;
  } catch (e) {
    const msg = `${(e as { meta?: { message?: string } }).meta?.message ?? ""} ${(e as Error).message}`;
    return (msg.match(/NN:(\w+)/) || [])[1] ?? null;
  }
}

/** Runs the statement in a PL/pgSQL block and returns the constraint named by a foreign_key_violation (nothing is kept). */
async function restrictingConstraint(sql: string): Promise<string | null> {
  const block = `DO $blk$ DECLARE c text; BEGIN ${sql}; RAISE EXCEPTION 'ACCEPTED'; EXCEPTION WHEN foreign_key_violation THEN GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME; RAISE EXCEPTION 'FK:%', c; END $blk$`;
  try {
    await prisma.$executeRawUnsafe(block);
    return null;
  } catch (e) {
    const msg = `${(e as { meta?: { message?: string } }).meta?.message ?? ""} ${(e as Error).message}`;
    return (msg.match(/FK:(\w+)/) || [])[1] ?? null;
  }
}

describe("Phase 2D.7 — PostgreSQL enforces groupId NOT NULL on every tenant-owned table", () => {
  it("schema: groupId is NOT NULL on all six tables (and still NOT NULL on GroupSetting)", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; is_nullable: string }>>(
      `SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'groupId' ORDER BY table_name`
    );
    const nullable = Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
    for (const t of [...TENANT_TABLES, "GroupSetting"]) expect(nullable[t], t).toBe("NO");
  });

  it("schema: the five Group foreign keys keep their names and are now ON DELETE RESTRICT / ON UPDATE CASCADE", async () => {
    const fks = await prisma.$queryRawUnsafe<Array<{ conname: string; del: string; upd: string }>>(
      `SELECT conname, confdeltype::text AS del, confupdtype::text AS upd FROM pg_constraint
       WHERE contype = 'f' AND confrelid = '"Group"'::regclass AND conname LIKE '%\\_groupId\\_fkey' ORDER BY conname`
    );
    const byName = Object.fromEntries(fks.map((f) => [f.conname, `${f.del}/${f.upd}`]));
    // 'r' = RESTRICT on delete, 'c' = CASCADE on update; GroupSetting keeps CASCADE/CASCADE (unchanged).
    expect(byName).toEqual({
      Player_groupId_fkey: "r/c",
      TeamGeneration_groupId_fkey: "r/c",
      TelegramChat_groupId_fkey: "r/c",
      TelegramPoll_groupId_fkey: "r/c",
      TelegramUserLink_groupId_fkey: "r/c",
      GroupSetting_groupId_fkey: "c/c",
      // M6-A: share links are viewer-access records, not tenant history;
      // they go with their Group (which RESTRICT above already protects).
      GroupShareLink_groupId_fkey: "c/c",
      // M6-B: delivery history is tenant data — protected like the M4 tables.
      MessageDelivery_groupId_fkey: "r/c",
      // M6-C: claim links / connect codes are access artifacts that go with their Group.
      PlayerClaim_groupId_fkey: "c/c",
      TelegramConnectCode_groupId_fkey: "c/c",
    });
  });

  it("schema: TelegramPollAnswer still has no Group foreign key (only its poll FK)", async () => {
    const fks = await prisma.$queryRawUnsafe<Array<{ target: string }>>(
      `SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND conrelid = '"TelegramPollAnswer"'::regclass`
    );
    expect(fks.map((f) => f.target)).toEqual(['"TelegramPoll"']);
  });

  it("schema: TeamGeneration (groupId, date) uniqueness is intact", async () => {
    const idx = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'TeamGeneration' AND indexname = 'TeamGeneration_groupId_date_key'`
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX .* \("groupId", date\)/);
  });

  it.each(TENANT_TABLES)("%s: a tenantless INSERT (groupId NULL) is rejected by PostgreSQL (23502 on groupId)", async (table) => {
    const rejected = await pgErrorCode(INSERTS[table].replace("$G", "NULL"));
    expect(rejected, `${table} accepted a NULL groupId`).not.toBeNull();
    expect(rejected!.code).toBe("23502"); // not_null_violation
    // Prove WHICH column PostgreSQL rejected (Prisma's message omits it).
    expect(await notNullViolationColumn(INSERTS[table].replace("$G", "NULL"))).toBe("groupId");
  });

  it.each(TENANT_TABLES)("%s: the identical INSERT with a valid Group succeeds (control)", async (table) => {
    expect(await pgErrorCode(INSERTS[table].replace("$G", `'${A}'`))).toBeNull();
  });

  it("deleting a Group that still owns rows is refused by PostgreSQL via ON DELETE RESTRICT (23503)", async () => {
    const res = await pgErrorCode(`DELETE FROM "Group" WHERE id = '${B}'`);
    expect(res).not.toBeNull();
    expect(res!.code).toBe("23503"); // foreign_key_violation raised by the RESTRICT rule
    expect(await restrictingConstraint(`DELETE FROM "Group" WHERE id = '${B}'`)).toMatch(/^(Player|TeamGeneration)_groupId_fkey$/);
    expect(await prisma.group.count({ where: { id: B } })).toBe(1);
    expect(await prisma.player.count({ where: { groupId: B } })).toBe(2);
  });

  it("a Group with no tenant-owned rows left can still be deleted (RESTRICT only guards dependents)", async () => {
    await prisma.organization.create({ data: { id: "org-empty", name: "Empty", slug: "empty-org" } });
    await prisma.group.create({ data: { id: "grp-empty", organizationId: "org-empty", name: "e", slug: "e", timezone: "America/New_York" } });
    expect(await pgErrorCode(`DELETE FROM "Group" WHERE id = 'grp-empty'`)).toBeNull();
    expect(await prisma.group.count({ where: { id: "grp-empty" } })).toBe(0);
  });
});
