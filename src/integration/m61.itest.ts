/**
 * M6.1 — REAL-DATABASE tests for Telegram identity management:
 * organizer "Remove Telegram link", player "Disconnect Telegram", and
 * OWNER/ADMIN-only organizer voter linking (link/move).
 *
 * Guarded local TEST database only. Real routes/services/Prisma; only the
 * NextAuth session lookup is mocked. Telegram is a recording fetch stub
 * (no real call); any other host is a counted, forbidden network call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { loadMyPlayers } from "@/app/me/data";
import * as removeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/telegram/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as claimRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/claim/route";
import * as linkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/link/route";
import * as importRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/import/route";
import * as usersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";
import * as acceptRoute from "@/app/api/claims/accept/route";
import * as connectRoute from "@/app/api/account/players/[playerId]/telegram-connect/route";
import * as disconnectRoute from "@/app/api/account/players/[playerId]/telegram/route";
import * as webhookRoute from "@/app/api/telegram/webhook/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const A2 = { organizationSlug: "org-a", groupSlug: "group-a2" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const TG = 555n; // one Telegram identity, linked in three Groups
const WEBHOOK_SECRET = "itest-webhook-secret";
const g = (x: typeof A) => ({ params: Promise.resolve(x) });
const gp = (x: typeof A, id: string) => ({ params: Promise.resolve({ ...x, id }) });
const pp = (playerId: string) => ({ params: Promise.resolve({ playerId }) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---------------------------------------------------------------- Telegram stub
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetworkCalls = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetworkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }
  tgCalls.push({ method: u.split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
  return { json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
}
const lastReply = () => String(tgCalls.filter((c) => c.method === "sendMessage").at(-1)?.body.text ?? "");
const webhook = (text: string, fromId: bigint) =>
  webhookRoute.POST(
    new Request("http://itest.local/api/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: JSON.stringify({ message: { text, chat: { id: Number(fromId) }, from: { id: Number(fromId) } } }),
    }) as never
  );

// ---------------------------------------------------------------- fixtures
async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
  return u;
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","MessageDelivery","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  const mk = (email: string) =>
    prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: verified } });
  const [ownerA, adminA, memberA, ownerB] = await Promise.all([
    mk("owner-a@example.test"),
    mk("admin-a@example.test"),
    mk("member-a@example.test"),
    mk("owner-b@example.test"),
  ]);
  await Promise.all([mk("player@example.test"), mk("other@example.test")]);
  for (const [orgId, slug] of [["org-a-id", "org-a"], ["org-b-id", "org-b"]]) {
    await prisma.organization.create({ data: { id: orgId, name: slug.toUpperCase(), slug, plan: "LEGACY" } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: ownerA.id, organizationId: "org-a-id", role: "OWNER" },
      { userId: adminA.id, organizationId: "org-a-id", role: "ADMIN" },
      { userId: memberA.id, organizationId: "org-a-id", role: "MEMBER" },
      { userId: ownerB.id, organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  for (const [id, orgId, slug, chat] of [["ga", "org-a-id", "group-a", 1001n], ["ga2", "org-a-id", "group-a2", 1002n], ["gb", "org-b-id", "group-b", 2001n]] as const) {
    await prisma.group.create({ data: { id, organizationId: orgId, name: slug, slug, sportKey: "soccer", timezone: "UTC", visibility: "PRIVATE" } });
    await prisma.telegramChat.create({ data: { chatId: chat, title: slug, groupId: id } });
    for (const n of [1, 2]) {
      await prisma.player.create({ data: { id: `${id}-p${n}`, groupId: id, firstName: slug, lastName: `P${n}`, position: "DEFENDER", rating: "GOOD", stamina: 3 } });
    }
    // The same Telegram identity is linked to Player 1 in EVERY Group; Player 2 has its own identity.
    await prisma.telegramUserLink.createMany({
      data: [
        { id: `link-${id}-p1`, userId: TG, playerId: `${id}-p1`, groupId: id },
        { id: `link-${id}-p2`, userId: chat * 10n, playerId: `${id}-p2`, groupId: id },
      ],
    });
    await prisma.teamGeneration.create({
      data: {
        id: `gen-${id}`,
        groupId: id,
        date: new Date("2026-10-05T00:00:00Z"),
        teamsJson: JSON.stringify([{ teamNumber: 1, players: [{ id: `${id}-p1`, firstName: slug, lastName: "P1" }] }]),
      },
    });
    await prisma.telegramPoll.create({
      data: { pollId: `poll-${id}`, chatId: chat, messageId: 9n, question: "Q", optionsJson: "[]", pollDate: new Date("2026-10-05T00:00:00Z"), groupId: id },
    });
    await prisma.telegramPollAnswer.createMany({
      data: [
        { pollId: `poll-${id}`, userId: TG, optionIdsJson: "[0]", groupId: id, firstName: "Same", lastName: "Person" },
        { pollId: `poll-${id}`, userId: chat * 10n, optionIdsJson: "[0]", groupId: id },
      ],
    });
    await prisma.messageDelivery.create({
      data: {
        id: `del-${id}`,
        groupId: id,
        eventType: "TEAMS_PUBLISHED",
        channel: "TELEGRAM",
        destination: String(chat),
        telegramPollId: `poll-${id}`,
        teamGenerationId: `gen-${id}`,
        contentHash: "h",
        status: "SENT",
        claimedAt: verified,
        sentAt: verified,
      },
    });
  }
}

/** Everything that must survive a link removal, keyed so a diff is readable. */
async function snapshot() {
  return {
    players: stringify(await prisma.player.findMany({ orderBy: { id: "asc" } })),
    claims: stringify(await prisma.playerClaim.findMany({ orderBy: { id: "asc" } })),
    users: stringify(await prisma.user.findMany({ orderBy: { id: "asc" } })),
    memberships: stringify(await prisma.organizationMembership.findMany({ orderBy: { id: "asc" } })),
    gens: stringify(await prisma.teamGeneration.findMany({ orderBy: { id: "asc" } })),
    polls: stringify(await prisma.telegramPoll.findMany({ orderBy: { pollId: "asc" } })),
    answers: stringify(await prisma.telegramPollAnswer.findMany({ orderBy: { id: "asc" } })),
    deliveries: stringify(await prisma.messageDelivery.findMany({ orderBy: { id: "asc" } })),
    chats: stringify(await prisma.telegramChat.findMany({ orderBy: { id: "asc" } })),
  };
}
const linkRows = async (where: object = {}) => stringify(await prisma.telegramUserLink.findMany({ where, orderBy: { id: "asc" } }));
const linksOf = async (playerId: string) => prisma.telegramUserLink.findMany({ where: { playerId }, select: { userId: true, groupId: true } });

const remove = (grp: typeof A, playerId: string) => removeRoute.DELETE(json("DELETE"), gp(grp, playerId));
const disconnect = (playerId: string) => disconnectRoute.DELETE(json("DELETE"), pp(playerId));
const importVoters = async (grp: typeof A, pollId: string) => (await importRoute.POST(json("POST", { pollId }), g(grp))).json();

async function claim(grp: typeof A, playerId: string, owner: string, email = "player@example.test") {
  await signInAs(owner);
  const { claimPath } = await (await claimRoute.POST(json("POST", {}), gp(grp, playerId))).json();
  const user = await signInAs(email);
  expect((await acceptRoute.POST(json("POST", { token: claimPath.split("#")[1] }))).status).toBe(200);
  return user;
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

beforeEach(async () => {
  session = null;
  tgCalls = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  await seed();
});

afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// =================================================================== organizer
describe("organizer: Remove Telegram link", () => {
  it("OWNER removes exactly one Group-scoped link; nothing else changes and no Telegram call is made", async () => {
    const before = await snapshot();
    const otherLinks = await linkRows({ NOT: { id: "link-ga-p1" } });
    await signInAs("owner-a@example.test");
    const res = await remove(A, "ga-p1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, removed: true });
    expect(stringify(body)).not.toContain(String(TG));
    expect(await prisma.telegramUserLink.findUnique({ where: { id: "link-ga-p1" } })).toBeNull();
    expect(await linkRows()).toBe(otherLinks); // incl. the same identity in group-a2 and group-b, byte-identical
    expect(await snapshot()).toEqual(before);
    expect(tgCalls).toEqual([]);
  });

  it("ADMIN can remove; the Players list then shows the Player as not connected", async () => {
    await signInAs("admin-a@example.test");
    expect((await remove(A, "ga-p2")).status).toBe(200);
    const list = await (await playersRoute.GET(json("GET"), g(A))).json();
    expect(list.find((p: { id: string }) => p.id === "ga-p2")).toMatchObject({ telegramConnected: false });
    expect(list.find((p: { id: string }) => p.id === "ga-p1")).toMatchObject({ telegramConnected: true });
    expect(stringify(list)).not.toContain(String(TG));
  });

  it("MEMBER, a claimed Player, another Organization and anonymous are refused (404/401) and nothing changes", async () => {
    await claim(A, "ga-p1", "owner-a@example.test");
    const links = await linkRows();
    await signInAs("member-a@example.test");
    expect((await remove(A, "ga-p1")).status).toBe(404);
    await signInAs("player@example.test"); // has claimed ga-p1 but no membership
    expect((await remove(A, "ga-p1")).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await remove(A, "ga-p1")).status).toBe(404); // foreign Organization in the URL
    expect((await remove(B, "ga-p1")).status).toBe(404); // own Organization, foreign Player id
    session = null;
    expect((await remove(A, "ga-p1")).status).toBe(401);
    expect(await linkRows()).toBe(links);
  });

  it("Player/Group substitution: a Player of another Group (same Organization) is 404 and its link survives", async () => {
    await signInAs("owner-a@example.test");
    const links = await linkRows();
    expect((await remove(A, "ga2-p1")).status).toBe(404);
    expect((await remove(A, "gb-p1")).status).toBe(404);
    expect((await remove(A, "no-such-player")).status).toBe(404);
    expect(await linkRows()).toBe(links);
  });

  it("repeated and concurrent removals are idempotent and never touch another mapping", async () => {
    await signInAs("owner-a@example.test");
    const others = await linkRows({ NOT: { id: "link-ga-p1" } });
    const results = await Promise.all([remove(A, "ga-p1"), remove(A, "ga-p1"), remove(A, "ga-p1")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const removed = (await Promise.all(results.map((r) => r.json()))).map((b) => b.removed);
    expect(removed.filter(Boolean)).toHaveLength(1);
    expect(await (await remove(A, "ga-p1")).json()).toEqual({ ok: true, removed: false });
    expect(await linkRows()).toBe(others);
  });

  it("a pending /connect code is invalidated so it cannot silently re-link the Player", async () => {
    await claim(A, "ga-p1", "owner-a@example.test");
    const code = (await (await connectRoute.POST(json("POST", {}), pp("ga-p1"))).json()).command.split(" ")[1];
    await signInAs("owner-a@example.test");
    await remove(A, "ga-p1");
    expect(await prisma.telegramConnectCode.count({ where: { playerId: "ga-p1" } })).toBe(0);
    await webhook(`/connect ${code}`, TG);
    expect(lastReply()).toContain("invalid or has expired");
    expect(await linksOf("ga-p1")).toEqual([]);
  });
});

// =================================================================== player
describe("player: Disconnect Telegram (/me)", () => {
  it("the claiming User disconnects their own Player; claim, history and other Groups' links stay", async () => {
    const user = await claim(A, "ga-p1", "owner-a@example.test");
    const before = await snapshot();
    const others = await linkRows({ NOT: { id: "link-ga-p1" } });
    expect((await loadMyPlayers(user.id))[0].telegramConnected).toBe(true);
    const res = await disconnect("ga-p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(await linksOf("ga-p1")).toEqual([]);
    expect(await linkRows()).toBe(others);
    expect(await snapshot()).toEqual(before); // Player.userId, claims, memberships, history unchanged
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).userId).toBe(user.id);
    expect((await loadMyPlayers(user.id))[0].telegramConnected).toBe(false);
    expect(await (await disconnect("ga-p1")).json()).toEqual({ ok: true, removed: false }); // repeat
    expect(tgCalls).toEqual([]);
  });

  it("cannot disconnect another Player, another Group's Player, or anything when unclaimed/anonymous", async () => {
    await claim(A, "ga-p1", "owner-a@example.test");
    const links = await linkRows();
    await signInAs("player@example.test");
    expect((await disconnect("ga-p2")).status).toBe(404); // same Group, not theirs
    expect((await disconnect("gb-p1")).status).toBe(404); // same Telegram identity, other Group
    expect((await disconnect("ga2-p1")).status).toBe(404);
    await signInAs("other@example.test"); // verified, claims nothing
    expect((await disconnect("ga-p1")).status).toBe(404);
    await signInAs("owner-a@example.test"); // the organizer is not the claiming User
    expect((await disconnect("ga-p1")).status).toBe(404);
    session = null;
    expect((await disconnect("ga-p1")).status).toBe(401);
    expect(await linkRows()).toBe(links);
  });

  it("after an organizer unlinks the account, the former User can no longer disconnect", async () => {
    const user = await claim(A, "ga-p1", "owner-a@example.test");
    await prisma.player.update({ where: { id: "ga-p1" }, data: { userId: null } });
    session = { user: { id: user.id, email: user.email } };
    expect((await disconnect("ga-p1")).status).toBe(404);
    expect(await linksOf("ga-p1")).toHaveLength(1);
  });
});

// =================================================================== multi-Group + import + reconnect
describe("multi-Group identity, history and future imports", () => {
  it("removing Group B leaves Group A byte-identical; imports diverge per Group; reconnect restores coexistence", async () => {
    const groupALinks = await linkRows({ groupId: "ga" });
    const history = await snapshot();

    await signInAs("owner-b@example.test");
    expect(await importVoters(B, "poll-gb")).toMatchObject({ selectedPlayerIds: expect.arrayContaining(["gb-p1"]) });
    expect((await remove(B, "gb-p1")).status).toBe(200);
    expect(await linksOf("gb-p1")).toEqual([]);
    expect(await linkRows({ groupId: "ga" })).toBe(groupALinks);
    expect(await snapshot()).toEqual(history);

    // Future import in B: the voter is unlinked; in A it still resolves.
    expect(await importVoters(B, "poll-gb")).toEqual({ ok: true, selectedPlayerIds: ["gb-p2"], missingUserIds: [String(TG)] });
    expect((await (await usersRoute.GET(json("GET"), g(B))).json()).map((u: { userId: string }) => u.userId)).toEqual([String(TG)]);
    await signInAs("owner-a@example.test");
    expect(await importVoters(A, "poll-ga")).toMatchObject({ selectedPlayerIds: expect.arrayContaining(["ga-p1", "ga-p2"]), missingUserIds: [] });

    // Organizer reconnect path (existing voter linking) in B.
    await signInAs("owner-b@example.test");
    expect((await linkRoute.POST(json("POST", { userId: String(TG), playerId: "gb-p1" }), g(B))).status).toBe(200);
    expect(await prisma.telegramUserLink.findMany({ where: { userId: TG }, select: { groupId: true, playerId: true }, orderBy: { groupId: "asc" } })).toEqual([
      { groupId: "ga", playerId: "ga-p1" },
      { groupId: "ga2", playerId: "ga2-p1" },
      { groupId: "gb", playerId: "gb-p1" },
    ]);
    expect(await linkRows({ groupId: "ga" })).toBe(groupALinks);
    expect(tgCalls).toEqual([]);
  });

  it("removing in one Group of the SAME Organization leaves the sibling Group's mapping intact", async () => {
    await signInAs("owner-a@example.test");
    const a2 = await linkRows({ groupId: "ga2" });
    expect((await remove(A, "ga-p1")).status).toBe(200);
    expect(await linkRows({ groupId: "ga2" })).toBe(a2);
    expect(await importVoters(A2, "poll-ga2")).toMatchObject({ selectedPlayerIds: expect.arrayContaining(["ga2-p1"]), missingUserIds: [] });
  });

  it("player reconnect after disconnect: /me → code → /start CODE → connected again, other Groups unchanged", async () => {
    await claim(B, "gb-p1", "owner-b@example.test");
    const groupALinks = await linkRows({ groupId: "ga" });
    expect((await disconnect("gb-p1")).status).toBe(200);
    const created = await (await connectRoute.POST(json("POST", {}), pp("gb-p1"))).json();
    const code = created.command.split(" ")[1];
    await webhook(`/start ${code}`, TG);
    expect(lastReply()).toContain("Connected your Telegram account to group-b P1");
    expect(await linksOf("gb-p1")).toEqual([{ userId: TG, groupId: "gb" }]);
    expect(await linkRows({ groupId: "ga" })).toBe(groupALinks);
    expect(await prisma.telegramUserLink.count({ where: { userId: TG } })).toBe(3);
  });
});

// =================================================================== organizer link/move authorization
describe("organizer Telegram voter linking (link/move) is OWNER/ADMIN only", () => {
  const link = (grp: typeof A, userId: string, playerId: string) => linkRoute.POST(json("POST", { userId, playerId }), g(grp));

  it("OWNER and ADMIN can link a new voter and move an identity within their Group", async () => {
    await signInAs("owner-a@example.test");
    expect((await remove(A, "ga-p2")).status).toBe(200); // free ga-p2
    expect((await link(A, "777", "ga-p2")).status).toBe(200); // link new voter
    expect(await linksOf("ga-p2")).toEqual([{ userId: 777n, groupId: "ga" }]);
    await signInAs("admin-a@example.test");
    expect((await remove(A, "ga-p2")).status).toBe(200);
    expect((await link(A, "888", "ga-p2")).status).toBe(200); // ADMIN links
    expect((await remove(A, "ga-p2")).status).toBe(200);
    expect((await link(A, String(TG), "ga-p2")).status).toBe(200); // ADMIN moves TG: ga-p1 → ga-p2
    expect(await linksOf("ga-p1")).toEqual([]);
    expect(await linksOf("ga-p2")).toEqual([{ userId: TG, groupId: "ga" }]);
  });

  it("MEMBER cannot link or move; a claimed Player, another Organization and anonymous cannot either — nothing changes", async () => {
    await claim(A, "ga-p1", "owner-a@example.test");
    await signInAs("owner-a@example.test");
    await remove(A, "ga-p2"); // an unlinked Player a MEMBER could otherwise target
    const links = await linkRows();
    for (const email of ["member-a@example.test", "player@example.test", "owner-b@example.test"]) {
      await signInAs(email);
      const linkNew = await link(A, "999", "ga-p2");
      const move = await link(A, String(TG), "ga-p2");
      expect([email, linkNew.status, move.status]).toEqual([email, 404, 404]);
      expect(await linkNew.json()).toEqual({ error: "NOT_FOUND" });
    }
    session = null;
    expect((await link(A, "999", "ga-p2")).status).toBe(401);
    expect(await linkRows()).toBe(links);
    expect(tgCalls).toEqual([]);
  });

  it("a claimed Player (no organizer role) can still self-connect through /connect", async () => {
    await claim(A, "ga-p2", "owner-a@example.test");
    await signInAs("owner-a@example.test");
    await remove(A, "ga-p2");
    await signInAs("player@example.test");
    expect((await link(A, "4242", "ga-p2")).status).toBe(404); // organizer route refused…
    const code = (await (await connectRoute.POST(json("POST", {}), pp("ga-p2"))).json()).command.split(" ")[1];
    await webhook(`/connect ${code}`, 4242n); // …self-service works
    expect(lastReply()).toContain("Connected your Telegram account to group-a P2");
    expect(await linksOf("ga-p2")).toEqual([{ userId: 4242n, groupId: "ga" }]);
  });

  it("an organizer move in Group B never modifies the same identity's mapping in Group A; cross-tenant targets are 404", async () => {
    const groupA = await linkRows({ groupId: "ga" });
    await signInAs("owner-b@example.test");
    expect((await remove(B, "gb-p2")).status).toBe(200);
    expect((await link(B, String(TG), "gb-p2")).status).toBe(200); // move within B
    expect(await linksOf("gb-p1")).toEqual([]);
    expect(await linksOf("gb-p2")).toEqual([{ userId: TG, groupId: "gb" }]);
    expect(await linkRows({ groupId: "ga" })).toBe(groupA);
    expect((await link(B, String(TG), "ga-p2")).status).toBe(404); // Player of another tenant
    await signInAs("owner-a@example.test");
    expect((await link(A, String(TG), "ga2-p2")).status).toBe(404); // sibling Group of the same Organization
    expect(await linkRows({ groupId: "ga" })).toBe(groupA);
  });
});

describe("network safety", () => {
  it("no non-Telegram network call happened", () => {
    expect(otherNetworkCalls).toBe(0);
  });
});
