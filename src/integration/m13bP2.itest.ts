/**
 * M13B P2 — RSVP recipient preview. REAL DATABASE (guarded local test DB only).
 * Read-only: no email, no Telegram, no records, no tokens (network is forbidden).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as previewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-preview/route";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
let network = 0;
const originalFetch = global.fetch;

const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const preview = async (matchId: string, org = "o", group = "g") => {
  const r = await previewRoute.GET(new Request("http://itest.local/api/x"), { params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
type Row = { playerId: string; name: string; status: string; source: string | null; maskedEmail: string | null };
const rows = (body: Record<string, unknown>) => Object.fromEntries((body.recipients as Row[]).map((r) => [r.playerId, { status: r.status, source: r.source, maskedEmail: r.maskedEmail }]));

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "PersonalAttendanceLink","AttendanceResponse","TelegramPoll","TelegramChat","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({
    data: [
      ...["owner", "admin", "member", "other", "linked", "free"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
      { id: "u-unverified", email: "unverified@example.test", name: "u", passwordHash: null, emailVerifiedAt: null },
    ],
  });
  await prisma.organization.createMany({
    data: [
      { id: "o", name: "Org", slug: "o", plan: "LEGACY" },
      { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" },
      { id: "of", name: "Free", slug: "of", plan: "FREE" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday", slug: "g", sportKey: "soccer", timezone: TZ },
      { id: "gx", organizationId: "o", name: "Second", slug: "gx", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other", slug: "g2", sportKey: "soccer", timezone: TZ },
      { id: "gf", organizationId: "of", name: "Free group", slug: "gf", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
      { userId: "u-free", organizationId: "of", role: "OWNER" },
    ],
  });
  const P = (id: string, firstName: string, extra: Record<string, unknown> = {}) => ({ id, groupId: "g", firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, ...extra });
  await prisma.player.createMany({
    data: [
      P("p1", "Ava", { contactEmail: "guardian.of.ava@example.com", contactEmailType: "GUARDIAN" }),
      P("p2", "Ben", { contactEmail: "ben.own@example.com", contactEmailType: "PLAYER" }),
      P("p3", "Cal", { userId: "u-linked" }), // verified account fallback
      P("p4", "Dee", { userId: "u-unverified" }), // unverified → NO_EMAIL
      P("p5", "Eli"), // nothing
      P("p6", "Fay", { contactEmail: "fay@example.com", contactEmailType: "PLAYER" }), // answered
      P("p7", "Gus", { contactEmail: "gus@example.com", contactEmailType: "PLAYER" }), // override
      P("p8", "Hal", { contactEmail: "hal@example.com", contactEmailType: "PLAYER", isActive: false }), // not on roster
      P("p9", "Ivy", { contactEmail: "broken", contactEmailType: "PLAYER" }), // stored contact no longer valid (bypassing the API)
    ],
  });
  await prisma.player.create({ data: { id: "px", groupId: "gx", firstName: "Xi", lastName: "Test", position: "MIDFIELDER", rating: "GOOD", stamina: 3, contactEmail: "xi@example.com", contactEmailType: "PLAYER" } });
  await prisma.match.create({ data: { id: "m", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00" } });
  await prisma.attendanceResponse.createMany({
    data: [
      { matchId: "m", groupId: "g", playerId: "p6", participantStatus: "MAYBE", participantSource: "PERSONAL_LINK", participantRespondedAt: new Date() },
      { matchId: "m", groupId: "g", playerId: "p7", overrideStatus: "NOT_PLAYING", overrideAt: new Date(), overrideByUserId: "u-owner" },
    ],
  });
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: Record<string, number> = {};
  for (const { t } of tables) out[t] = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`))[0].n);
  return out;
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    network++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});
beforeEach(async () => {
  network = 0;
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
});

describe("M13B P2 — classification", () => {
  it("every status, guardian labels, masked destinations; not-on-roster listed separately", async () => {
    const r = await preview("m");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store, private");
    expect(rows(r.body)).toEqual({
      p1: { status: "WILL_SEND", source: "GUARDIAN", maskedEmail: "g•••@example.com" },
      p2: { status: "WILL_SEND", source: "PLAYER", maskedEmail: "b•••@example.com" },
      p3: { status: "WILL_SEND", source: "ACCOUNT", maskedEmail: "l•••@example.test" },
      p4: { status: "NO_EMAIL", source: null, maskedEmail: null },
      p5: { status: "NO_EMAIL", source: null, maskedEmail: null },
      p6: { status: "ALREADY_ANSWERED", source: "PLAYER", maskedEmail: "f•••@example.com" },
      p7: { status: "ORGANIZER_OVERRIDE", source: "PLAYER", maskedEmail: "g•••@example.com" },
      p9: { status: "INVALID_CONTACT", source: null, maskedEmail: null },
    });
    expect(r.body.notOnRoster).toEqual([{ playerId: "p8", name: "Hal Test", status: "NOT_ON_ROSTER" }]);
    expect(r.body.counts).toMatchObject({ willSend: 3, excluded: 5, byStatus: { NOT_ON_ROSTER: 1, SUPPRESSED: 0, OVER_LIMIT: 0 } });
    expect(r.body).toMatchObject({ suppression: { available: true }, sending: { available: true } }); // NODE_ENV=test → the test outbox (never in Production / Preview)
    expect(r.body.allowance).toMatchObject({ plan: "LEGACY", day: { limit: 50, used: 0, reserved: 0, remaining: 50 }, month: { limit: 500, used: 0, reserved: 0, remaining: 500 } });
    expect(r.body.counts).toMatchObject({ overLimitIsProvisional: true });
    const text = JSON.stringify(r.body);
    for (const secret of ["guardian.of.ava", "ben.own", "linked@", "unverified@", "fay@", "gus@", "hal@", "xi@", "contactEmail"]) expect(text, secret).not.toContain(secret);
  });

  it("a community match: only that community's roster is eligible; other group players are NOT_ON_ROSTER", async () => {
    await prisma.community.create({ data: { id: "c", groupId: "g", name: "Mondays" } });
    await prisma.communityPlayer.createMany({ data: ["p1", "p2"].map((playerId) => ({ groupId: "g", communityId: "c", playerId })) });
    await prisma.match.create({ data: { id: "mc", groupId: "g", date: new Date("2099-06-04"), communityId: "c" } });
    const r = await preview("mc");
    expect(Object.keys(rows(r.body)).sort()).toEqual(["p1", "p2"]);
    expect((r.body.notOnRoster as Array<{ playerId: string }>).map((p) => p.playerId).sort()).toEqual(["p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
  });

  it("Free plan: allowance 100 / 20; sendable recipients beyond the daily allowance are OVER_LIMIT (provisional)", async () => {
    await prisma.player.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({ id: `f${String(i).padStart(2, "0")}`, groupId: "gf", firstName: `F${String(i).padStart(2, "0")}`, lastName: "Free", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail: `f${i}@example.com`, contactEmailType: "PLAYER" as const })),
    });
    await prisma.match.create({ data: { id: "mf", groupId: "gf", date: new Date("2099-06-03") } });
    signIn("free");
    const r = await preview("mf", "of", "gf");
    expect(r.body.allowance).toMatchObject({ plan: "FREE", day: { limit: 20, used: 0, remaining: 20 }, month: { limit: 100, used: 0, remaining: 100 } });
    expect(r.body.counts).toMatchObject({ willSend: 20, byStatus: { OVER_LIMIT: 2 } });
    expect((r.body.recipients as Row[]).filter((x) => x.status === "OVER_LIMIT").map((x) => x.playerId)).toEqual(["f20", "f21"]); // deterministic: name order
    // A running trial keeps Pro features but Free's RSVP email ceilings.
    await prisma.organization.update({ where: { id: "of" }, data: { trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 30 * 86_400_000) } });
    expect((await preview("mf", "of", "gf")).body.allowance).toMatchObject({ plan: "TRIAL", day: { limit: 20 }, month: { limit: 100 } });
  });
});

describe("M13B P2 — match eligibility", () => {
  it("Telegram match → 409 TELEGRAM_MATCH (poll or connected chat)", async () => {
    const chat = await prisma.telegramChat.create({ data: { chatId: -100n, title: "Chat", groupId: "g" } });
    await prisma.match.update({ where: { id: "m" }, data: { telegramChatId: chat.id } });
    expect(await preview("m")).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH" } });
    await prisma.match.update({ where: { id: "m" }, data: { telegramChatId: null } });
    await prisma.telegramPoll.create({ data: { pollId: "poll", chatId: -100n, question: "q", optionsJson: "[]", groupId: "g", matchId: "m", kind: "ATTENDANCE" } });
    expect(await preview("m")).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH" } });
  });
  it("canceled, completed, closed and deadline-passed → 409 with their own codes", async () => {
    const at = (data: Record<string, unknown>) => prisma.match.update({ where: { id: "m" }, data });
    await at({ status: "CANCELED" });
    expect((await preview("m")).body.code).toBe("MATCH_CANCELED");
    await at({ status: "COMPLETED" });
    expect((await preview("m")).body.code).toBe("MATCH_COMPLETED");
    await at({ status: "SCHEDULED", attendanceClosedAt: new Date() });
    expect((await preview("m")).body.code).toBe("ATTENDANCE_CLOSED");
    await at({ attendanceClosedAt: null, attendanceDeadlineAt: new Date(Date.now() - 1000) });
    expect(await preview("m")).toMatchObject({ status: 409, body: { code: "DEADLINE_PASSED" } });
    await at({ attendanceDeadlineAt: new Date(Date.now() + 3_600_000) });
    expect((await preview("m")).status).toBe(200);
  });
});

describe("M13B P2 — authorization and isolation", () => {
  it("ADMIN allowed; MEMBER, other organization, other group, unknown match → 404 without details; signed out → 401", async () => {
    signIn("admin");
    expect((await preview("m")).status).toBe(200);
    await prisma.match.create({ data: { id: "mx", groupId: "gx", date: new Date("2099-06-03") } });
    for (const [who, matchId, org, group] of [
      ["member", "m", "o", "g"],
      ["other", "m", "o", "g"],
      ["other", "m", "o2", "g2"],
      ["owner", "mx", "o", "g"], // other group's match through this group's URL
      ["owner", "nope", "o", "g"],
    ] as const) {
      signIn(who);
      const r = await preview(matchId, org, group);
      expect(r.status, `${who} ${matchId} ${org}/${group}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/recipients|Ava|example\.com/);
    }
    signIn(null);
    expect((await preview("m")).status).toBe(401);
  });
});

describe("M13B P2 — read-only", () => {
  it("a preview creates or changes nothing in any table, sends nothing and generates no tokens", async () => {
    const before = await tableCounts();
    const attendanceBefore = await prisma.attendanceResponse.findMany({ orderBy: { playerId: "asc" } });
    for (let i = 0; i < 3; i++) expect((await preview("m")).status).toBe(200);
    expect(await tableCounts()).toEqual(before);
    expect(await prisma.attendanceResponse.findMany({ orderBy: { playerId: "asc" } })).toEqual(attendanceBefore);
    expect(await prisma.personalAttendanceLink.count()).toBe(0);
    expect(network).toBe(0);
  });
});
