/**
 * M6-C — REAL-DATABASE tests for Player claiming, claimed-player access,
 * organizer privilege separation, Group-scoped Telegram identities and
 * the secure /connect flow.
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
import { hashToken } from "@/lib/secureToken";
import { loadMyPlayers } from "@/app/me/data";
import { loadPublicGroupHomeData } from "@/app/g/[organizationSlug]/[groupSlug]/data";
import * as claimRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/claim/route";
import * as accountRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/account/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as visibilityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/visibility/route";
import * as shareLinkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/share-link/route";
import * as createPollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/create-poll/route";
import * as linkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/link/route";
import * as importRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/import/route";
import * as usersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";
import * as previewRoute from "@/app/api/claims/preview/route";
import * as acceptRoute from "@/app/api/claims/accept/route";
import * as connectRoute from "@/app/api/account/players/[playerId]/telegram-connect/route";
import * as webhookRoute from "@/app/api/telegram/webhook/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const WEBHOOK_SECRET = "itest-webhook-secret";
const g = (x: typeof A) => ({ params: Promise.resolve(x) });
const gp = (x: typeof A, id: string) => ({ params: Promise.resolve({ ...x, id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

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
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  return { json: async () => ({ ok: true, result: { message_id: 1, poll: { id: "tg-new" } } }) } as unknown as Response;
}
const lastReply = () => String(tgCalls.filter((c) => c.method === "sendMessage").at(-1)?.body.text ?? "");
const webhook = (text: string, fromId: number) =>
  webhookRoute.POST(
    new Request("http://itest.local/api/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: JSON.stringify({ message: { text, chat: { id: fromId }, from: { id: fromId } } }),
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
  const mk = (email: string, v: Date | null = verified) =>
    prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: v } });
  const [ownerA, adminA, ownerB] = await Promise.all([mk("owner-a@example.test"), mk("admin-a@example.test"), mk("owner-b@example.test")]);
  await Promise.all([mk("player@example.test"), mk("other@example.test"), mk("unverified@example.test", null)]);
  for (const [orgId, slug] of [["org-a-id", "org-a"], ["org-b-id", "org-b"]]) {
    await prisma.organization.create({ data: { id: orgId, name: slug.toUpperCase(), slug, plan: "LEGACY" } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: ownerA.id, organizationId: "org-a-id", role: "OWNER" },
      { userId: adminA.id, organizationId: "org-a-id", role: "ADMIN" },
      { userId: ownerB.id, organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  for (const [id, orgId, slug, sport, chat] of [["ga", "org-a-id", "group-a", "soccer", 1001n], ["gb", "org-b-id", "group-b", "volleyball", 2001n]] as const) {
    await prisma.group.create({ data: { id, organizationId: orgId, name: slug, slug, sportKey: sport, timezone: "UTC", visibility: "PRIVATE" } });
    await prisma.telegramChat.create({ data: { chatId: chat, title: slug, groupId: id } });
    for (const n of [1, 2]) {
      await prisma.player.create({ data: { id: `${id}-p${n}`, groupId: id, firstName: `${slug}`, lastName: `P${n}`, position: "DEFENDER", rating: "EXCELLENT", stamina: 5 } });
    }
    await prisma.teamGeneration.create({
      data: {
        id: `gen-${id}`,
        groupId: id,
        date: new Date("2026-10-05T00:00:00Z"),
        teamsJson: JSON.stringify([
          { teamNumber: 1, players: [{ id: `${id}-p1`, firstName: slug, lastName: "P1", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 }] },
          { teamNumber: 2, players: [{ id: `${id}-p2`, firstName: slug, lastName: "P2", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 }] },
        ]),
      },
    });
    await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId: chat, messageId: 9n, question: "Q", optionsJson: "[]", pollDate: new Date("2026-10-05T00:00:00Z"), groupId: id } });
  }
}

async function historyFingerprint() {
  return JSON.stringify(
    {
      gens: await prisma.teamGeneration.findMany({ orderBy: { id: "asc" } }),
      polls: await prisma.telegramPoll.findMany({ orderBy: { pollId: "asc" } }),
      answers: await prisma.telegramPollAnswer.findMany({ orderBy: { id: "asc" } }),
      links: await prisma.telegramUserLink.findMany({ orderBy: { id: "asc" } }),
      deliveries: await prisma.messageDelivery.findMany({ orderBy: { id: "asc" } }),
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v)
  );
}

async function issueClaim(email = "owner-a@example.test", grp = A, playerId = "ga-p1") {
  await signInAs(email);
  const res = await claimRoute.POST(json("POST", {}), gp(grp, playerId));
  const data = await res.json();
  return { res, data, token: typeof data.claimPath === "string" ? data.claimPath.split("#")[1] : "" };
}
const accept = (token: unknown) => acceptRoute.POST(json("POST", { token }));
const preview = async (token: unknown) => (await previewRoute.POST(json("POST", { token }))).json();

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

// =================================================================== claims
describe("Player claim links", () => {
  it("OWNER issues a link: hash-only storage, 7-day expiry, raw token returned once", async () => {
    vi.stubEnv("APP_BASE_URL", "https://teambalancepro.test");
    const { res, data, token } = await issueClaim();
    expect(res.status).toBe(201);
    expect(data.claimPath).toMatch(/^\/claim#[A-Za-z0-9_-]{43}$/);
    // Copyable absolute URL on the canonical origin (fragment design kept).
    expect(data.claimUrl).toBe(`https://teambalancepro.test/claim#${token}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The normal Player-list API never carries the token.
    await signInAs("owner-a@example.test");
    const list = await (await playersRoute.GET(json("GET"), g(A))).text();
    expect(list).not.toContain(token);
    expect(list).not.toContain("/claim#");
    const rows = await prisma.playerClaim.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playerId: "ga-p1", groupId: "ga", tokenHash: hashToken(token), usedAt: null, revokedAt: null });
    expect(JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "PlayerClaim"`))).not.toContain(token);
    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(Math.round(ttl / 86_400_000)).toBe(7);
  });

  it("previewing (what a link scanner does) never consumes the claim", async () => {
    const { token } = await issueClaim();
    session = null;
    expect(await preview(token)).toEqual({ status: "valid", organizationName: "ORG-A", groupName: "group-a", sportKey: "soccer", playerName: "group-a P1" });
    expect(await preview(token)).toMatchObject({ status: "valid" });
    expect((await prisma.playerClaim.findFirstOrThrow()).usedAt).toBeNull();
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).userId).toBeNull();
  });

  it("a verified User claims the EXISTING Player (no duplicate); history is untouched", async () => {
    const { token } = await issueClaim();
    const before = await historyFingerprint();
    const playersBefore = await prisma.player.count();
    const user = await signInAs("player@example.test");
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClaimed: false, href: "/me" });
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).userId).toBe(user.id);
    expect(await prisma.player.count()).toBe(playersBefore);
    expect(await historyFingerprint()).toBe(before);
    expect(await prisma.playerClaim.findFirstOrThrow()).toMatchObject({ acceptedByUserId: user.id, usedAt: expect.any(Date) });
    // replay by the same User is idempotent; by anyone else it is "used"
    expect((await accept(token)).status).toBe(200);
    await signInAs("other@example.test");
    expect((await accept(token)).status).toBe(410);
  });

  it("anonymous → 401, unverified → 403; neither consumes the claim", async () => {
    const { token } = await issueClaim();
    session = null;
    expect((await accept(token)).status).toBe(401);
    await signInAs("unverified@example.test");
    expect((await accept(token)).status).toBe(403);
    expect((await prisma.playerClaim.findFirstOrThrow()).usedAt).toBeNull();
  });

  it("expired, revoked, replaced and garbage tokens are rejected", async () => {
    const first = (await issueClaim()).token;
    const second = (await issueClaim()).token; // replacement revokes the first
    await signInAs("player@example.test");
    expect((await accept(first)).status).toBe(400);
    expect(await preview(first)).toEqual({ status: "invalid" });

    await prisma.playerClaim.updateMany({ where: { tokenHash: hashToken(second) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(second)).status).toBe(410);

    const third = (await issueClaim()).token;
    await signInAs("owner-a@example.test");
    expect((await claimRoute.DELETE(json("DELETE"), gp(A, "ga-p1"))).status).toBe(200);
    await signInAs("player@example.test");
    expect((await accept(third)).status).toBe(400);
    expect((await accept("x".repeat(43))).status).toBe(400);
    expect((await accept(undefined)).status).toBe(400);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).userId).toBeNull();
  });

  it("a Player already claimed cannot be claimed by another User (and no new link can be issued)", async () => {
    const { token } = await issueClaim();
    await signInAs("player@example.test");
    await accept(token);
    const again = await issueClaim();
    expect(again.res.status).toBe(409);
  });

  it("one Player per User per Group; Players in other Groups are fine", async () => {
    const t1 = (await issueClaim("owner-a@example.test", A, "ga-p1")).token;
    const t2 = (await issueClaim("owner-a@example.test", A, "ga-p2")).token;
    const t3 = (await issueClaim("owner-b@example.test", B, "gb-p1")).token;
    const user = await signInAs("player@example.test");
    expect((await accept(t1)).status).toBe(200);
    const res = await accept(t2);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ALREADY_HAS_PLAYER_IN_GROUP" });
    expect((await accept(t3)).status).toBe(200);
    expect((await prisma.player.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } })).map((p) => p.id)).toEqual(["ga-p1", "gb-p1"]);
  });

  it("claim management is tenant-bound and OWNER/ADMIN-only", async () => {
    expect((await issueClaim("owner-b@example.test", A, "ga-p1")).res.status).toBe(404); // other org
    expect((await issueClaim("owner-a@example.test", A, "gb-p1")).res.status).toBe(404); // other group's player
    expect((await issueClaim("admin-a@example.test", A, "ga-p2")).res.status).toBe(201);
    await prisma.organizationMembership.create({ data: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: "other@example.test" } })).id, organizationId: "org-a-id", role: "MEMBER" } });
    expect((await issueClaim("other@example.test", A, "ga-p1")).res.status).toBe(404); // MEMBER
  });

  it("organizer list shows only booleans — never the claiming User", async () => {
    const { token } = await issueClaim("owner-a@example.test", A, "ga-p1");
    await issueClaim("owner-a@example.test", A, "ga-p2");
    const user = await signInAs("player@example.test");
    await accept(token);
    await signInAs("owner-a@example.test");
    const text = await (await playersRoute.GET(json("GET"), g(A))).text();
    const list = JSON.parse(text);
    expect(list.find((p: { id: string }) => p.id === "ga-p1")).toMatchObject({ accountClaimed: true, claimPending: false, telegramConnected: false });
    expect(list.find((p: { id: string }) => p.id === "ga-p2")).toMatchObject({ accountClaimed: false, claimPending: true });
    expect(text).not.toContain(user.id);
    expect(text).not.toMatch(/userId|player@example|telegramUserId/);
  });

  it("organizer unlink: clears only Player.userId, keeps User/Player/history/Telegram link, and is audited", async () => {
    const { token } = await issueClaim();
    const user = await signInAs("player@example.test");
    await accept(token);
    await prisma.telegramUserLink.create({ data: { userId: 777n, playerId: "ga-p1", groupId: "ga" } });
    const before = await historyFingerprint();

    const owner = await signInAs("owner-a@example.test");
    expect((await accountRoute.DELETE(json("DELETE"), gp(A, "ga-p1"))).status).toBe(200);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).userId).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await historyFingerprint()).toBe(before);
    expect(await prisma.playerClaim.findFirstOrThrow()).toMatchObject({ acceptedByUserId: user.id, unlinkedByUserId: owner.id, unlinkedAt: expect.any(Date) });
    expect((await accountRoute.DELETE(json("DELETE"), gp(A, "ga-p1"))).status).toBe(409);

    await signInAs("owner-b@example.test");
    expect((await accountRoute.DELETE(json("DELETE"), gp(A, "ga-p2"))).status).toBe(404);
  });
});

// =================================================================== access
describe("claimed-player access vs organizer privileges", () => {
  async function claimAs(email: string, grp: typeof A, playerId: string, owner: string) {
    const { token } = await issueClaim(owner, grp, playerId);
    await signInAs(email);
    expect((await accept(token)).status).toBe(200);
  }

  it("PRIVATE Group: its claimed Player can view; an unrelated verified User cannot", async () => {
    await claimAs("player@example.test", A, "ga-p1", "owner-a@example.test");
    expect(await loadPublicGroupHomeData(A)).not.toBeNull();
    expect(await loadPublicGroupHomeData(B)).toBeNull(); // claimed nothing in B
    await signInAs("other@example.test");
    expect(await loadPublicGroupHomeData(A)).toBeNull();
    session = null;
    expect(await loadPublicGroupHomeData(A)).toBeNull();
  });

  it("a claimed Player gets NO organizer access: players, settings, share links, polls, claims, Telegram link", async () => {
    await claimAs("player@example.test", A, "ga-p1", "owner-a@example.test");
    tgCalls = [];
    expect((await playersRoute.GET(json("GET"), g(A))).status).toBe(404);
    expect((await playersRoute.POST(json("POST", { firstName: "X", lastName: "Y", position: "DEFENDER", rating: "GOOD" }), g(A))).status).toBe(404);
    expect((await visibilityRoute.GET(json("GET"), g(A))).status).toBe(404);
    expect((await visibilityRoute.PUT(json("PUT", { visibility: "PUBLIC" }), g(A))).status).toBe(404);
    expect((await shareLinkRoute.POST(json("POST", {}), g(A))).status).toBe(404);
    expect((await shareLinkRoute.DELETE(json("DELETE"), g(A))).status).toBe(404);
    expect((await createPollRoute.POST(json("POST", { chatId: "1001", pollDate: "2026-10-12" }), g(A))).status).toBe(404);
    expect((await claimRoute.POST(json("POST", {}), gp(A, "ga-p2"))).status).toBe(404);
    expect((await accountRoute.DELETE(json("DELETE"), gp(A, "ga-p1"))).status).toBe(404);
    expect((await linkRoute.POST(json("POST", { userId: "5", playerId: "ga-p2" }), g(A))).status).toBe(404);
    expect(tgCalls).toEqual([]);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "ga" } })).visibility).toBe("PRIVATE");
    expect(await prisma.groupShareLink.count()).toBe(0);
  });

  it("/me lists only the User's claimed Players with player-facing data only", async () => {
    await claimAs("player@example.test", A, "ga-p1", "owner-a@example.test");
    const { token } = await issueClaim("owner-b@example.test", B, "gb-p2");
    const user = await signInAs("player@example.test");
    await accept(token);
    const mine = await loadMyPlayers(user.id);
    expect(mine.map((p) => [p.groupName, p.sportKey, p.displayName])).toEqual([
      ["group-a", "soccer", "group-a P1"],
      ["group-b", "volleyball", "group-b P2"],
    ]);
    expect(mine[0].recent).toEqual([{ date: "2026-10-05", teamNumber: 1, teammates: ["group-a P1"] }]);
    expect(mine[1].recent).toEqual([{ date: "2026-10-05", teamNumber: 2, teammates: ["group-b P2"] }]);
    expect(JSON.stringify(mine)).not.toMatch(/EXCELLENT|rating|stamina|telegramUserId|email/);
    expect(await loadMyPlayers((await prisma.user.findUniqueOrThrow({ where: { email: "other@example.test" } })).id)).toEqual([]);
  });
});

// =================================================================== Telegram identity
describe("Group-scoped Telegram identity", () => {
  it("the same Telegram user can be linked in Group A and Group B; import resolves the Group-specific Player", async () => {
    await signInAs("owner-a@example.test");
    expect((await linkRoute.POST(json("POST", { userId: "555", playerId: "ga-p1" }), g(A))).status).toBe(200);
    await signInAs("owner-b@example.test");
    expect((await linkRoute.POST(json("POST", { userId: "555", playerId: "gb-p2" }), g(B))).status).toBe(200);
    expect(await prisma.telegramUserLink.count({ where: { userId: 555n } })).toBe(2);

    await prisma.telegramPollAnswer.createMany({
      data: [
        { pollId: "poll-ga", userId: 555n, optionIdsJson: "[0]", groupId: "ga" },
        { pollId: "poll-gb", userId: 555n, optionIdsJson: "[0]", groupId: "gb" },
      ],
    });
    await signInAs("owner-a@example.test");
    expect(await (await importRoute.POST(json("POST", { pollId: "poll-ga" }), g(A))).json()).toMatchObject({ selectedPlayerIds: ["ga-p1"], missingUserIds: [] });
    await signInAs("owner-b@example.test");
    expect(await (await importRoute.POST(json("POST", { pollId: "poll-gb" }), g(B))).json()).toMatchObject({ selectedPlayerIds: ["gb-p2"], missingUserIds: [] });
  });

  it("inside one Group: re-linking moves the identity; a Player with a different identity is a clear 409; never two links", async () => {
    await signInAs("owner-a@example.test");
    await linkRoute.POST(json("POST", { userId: "555", playerId: "ga-p1" }), g(A));
    expect((await linkRoute.POST(json("POST", { userId: "555", playerId: "ga-p2" }), g(A))).status).toBe(200);
    expect(await prisma.telegramUserLink.findMany({ where: { groupId: "ga" }, select: { userId: true, playerId: true } })).toEqual([{ userId: 555n, playerId: "ga-p2" }]);

    const res = await linkRoute.POST(json("POST", { userId: "777", playerId: "ga-p2" }), g(A));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This player is already linked to a different Telegram account." });
    await expect(
      prisma.telegramUserLink.create({ data: { userId: 555n, playerId: "ga-p1", groupId: "ga" } })
    ).rejects.toMatchObject({ code: "P2002" }); // DB: one identity per Group
  });

  it("cross-tenant linking is rejected; unlinked voters still surface per Group", async () => {
    await signInAs("owner-a@example.test");
    expect((await linkRoute.POST(json("POST", { userId: "555", playerId: "gb-p1" }), g(A))).status).toBe(404);
    await prisma.telegramPollAnswer.create({ data: { pollId: "poll-ga", userId: 888n, optionIdsJson: "[0]", groupId: "ga" } });
    expect((await (await usersRoute.GET(json("GET"), g(A))).json()).map((u: { userId: string }) => u.userId)).toEqual(["888"]);
    await signInAs("owner-b@example.test");
    expect(await (await usersRoute.GET(json("GET"), g(B))).json()).toEqual([]);
  });
});

// =================================================================== /connect
describe("secure Telegram /connect for claimed Players", () => {
  async function claimedPlayer() {
    const { token } = await issueClaim();
    const user = await signInAs("player@example.test");
    await accept(token);
    return user;
  }
  const createCode = async (playerId = "ga-p1") => connectRoute.POST(json("POST", {}), { params: Promise.resolve({ playerId }) });

  it("only the claiming User can create a code; codes are short-lived and hash-only", async () => {
    await claimedPlayer();
    const res = await createCode();
    expect(res.status).toBe(201);
    const { command, expiresAt } = await res.json();
    expect(command).toMatch(/^\/connect [A-Za-z0-9_-]{22}$/);
    const code = command.split(" ")[1];
    const row = await prisma.telegramConnectCode.findFirstOrThrow();
    expect(row.codeHash).toBe(hashToken(code));
    expect(JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "TelegramConnectCode"`), (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(code);
    const ttl = new Date(expiresAt).getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(15 * 60 * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);

    expect((await createCode("ga-p2")).status).toBe(404); // not their Player
    await signInAs("owner-a@example.test");
    expect((await createCode("ga-p1")).status).toBe(404); // the organizer is not the claimed User
    session = null;
    expect((await createCode("ga-p1")).status).toBe(401);
  });

  it("/connect CODE links the SENDER to the claimed Player in its Group; single-use; old codes replaced", async () => {
    await claimedPlayer();
    const first = (await (await createCode()).json()).command.split(" ")[1];
    const code = (await (await createCode()).json()).command.split(" ")[1];
    await webhook(`/connect ${first}`, 4242);
    expect(lastReply()).toContain("invalid or has expired");
    await webhook(`/connect ${code}`, 4242);
    expect(lastReply()).toBe("✅ Connected your Telegram account to group-a P1 (group-a).");
    expect(await prisma.telegramUserLink.findMany({ select: { userId: true, playerId: true, groupId: true } })).toEqual([
      { userId: 4242n, playerId: "ga-p1", groupId: "ga" },
    ]);
    await webhook(`/connect ${code}`, 9999); // replay
    expect(lastReply()).toContain("invalid or has expired");
    expect(await prisma.telegramUserLink.count()).toBe(1);
  });

  it("expired codes, guessable input and identities already used by another Player in the Group are refused", async () => {
    await claimedPlayer();
    const code = (await (await createCode()).json()).command.split(" ")[1];
    await prisma.telegramConnectCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await webhook(`/connect ${code}`, 4242);
    expect(lastReply()).toContain("invalid or has expired");
    for (const guess of ["/connect ga-p1", "/connect player@example.test", "/connect 123456"]) {
      await webhook(guess, 4242);
      expect(lastReply()).toContain("invalid or has expired");
    }
    await prisma.telegramUserLink.create({ data: { userId: 4242n, playerId: "ga-p2", groupId: "ga" } });
    const fresh = (await (await createCode()).json()).command.split(" ")[1];
    await webhook(`/connect ${fresh}`, 4242);
    expect(lastReply()).toContain("already linked to another player");
    expect((await prisma.telegramUserLink.findMany()).map((l) => l.playerId)).toEqual(["ga-p2"]);
  });

  it("the retired /link <playerId> writes nothing", async () => {
    await webhook("/link ga-p1", 4242);
    expect(lastReply()).toContain("no longer supported");
    expect(await prisma.telegramUserLink.count()).toBe(0);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } })).telegramUserId).toBeNull();
  });

  it("claims and Telegram links are independent", async () => {
    const user = await claimedPlayer();
    // claimed, no Telegram link
    expect(await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" }, select: { userId: true, telegramLink: true } })).toEqual({ userId: user.id, telegramLink: [] });
    // Telegram link, no claim
    await prisma.telegramUserLink.create({ data: { userId: 31n, playerId: "ga-p2", groupId: "ga" } });
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "ga-p2" } })).userId).toBeNull();
  });
});

describe("network safety", () => {
  it("no non-Telegram network call happened", () => {
    expect(otherNetworkCalls).toBe(0);
  });
});
