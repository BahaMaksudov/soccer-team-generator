/**
 * M13B P1 — organizer-managed player contact emails. REAL DATABASE (guarded local
 * test DB only). Nothing sends email or Telegram messages (network is forbidden).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as contactRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/contact/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as publicPlayersRoute from "@/app/api/public/[organizationSlug]/[groupSlug]/players/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as ownAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";
import { loadRecipients } from "@/lib/playerContact";
import { resolveShareView } from "@/lib/shareLinks";
import { buildPlayerMatchView } from "@/lib/matchPage";
import { loadMyGames } from "@/lib/myGames";
import { generateToken, hashToken } from "@/lib/secureToken";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
const SECRET_A = "guardian.of.pat+soccer@example.com";
const SECRET_B = "sam.own.address@example.com";
let network = 0;
const originalFetch = global.fetch;

const json = (method: string, body?: unknown) => new Request("http://itest.local/api/x", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, text: "", body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const gp = (id: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, id }) });
const g = (org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const getContact = (id: string, org?: string, group?: string) => call(contactRoute.GET(json("GET"), gp(id, org, group)));
const putContact = (id: string, body: unknown, org?: string, group?: string) => call(contactRoute.PUT(json("PUT", body), gp(id, org, group)));
const row = (id: string) => prisma.player.findUniqueOrThrow({ where: { id }, select: { contactEmail: true, contactEmailType: true, contactEmailUpdatedAt: true } });

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "AttendanceResponse","TeamGeneration","Match","GroupShareLink","CommunityPlayer","Community","PlayerClaim","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({
    data: [
      ...["owner", "admin", "member", "other", "player"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
      { id: "u-unverified", email: "unverified@example.test", name: "u", passwordHash: null, emailVerifiedAt: null },
    ],
  });
  await prisma.organization.createMany({ data: [{ id: "o", name: "Org", slug: "o", plan: "LEGACY" }, { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" }] });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday Soccer", slug: "g", sportKey: "soccer", timezone: TZ, visibility: "PUBLIC" },
      { id: "gx", organizationId: "o", name: "Second", slug: "gx", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other", slug: "g2", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
    ],
  });
  const P = (id: string, groupId: string, firstName: string, userId: string | null = null) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, userId });
  await prisma.player.createMany({
    data: [P("p1", "g", "Pat", "u-player"), P("p2", "g", "Sam"), P("p3", "g", "Kim", "u-unverified"), P("p4", "g", "Lee"), P("px", "gx", "Xi"), P("p9", "g2", "Nine", "u-other")],
  });
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

describe("M13B P1 — schema and migration", () => {
  it("existing players stay valid with no contact; the CHECK keeps email and type together", async () => {
    expect(await row("p1")).toEqual({ contactEmail: null, contactEmailType: null, contactEmailUpdatedAt: null });
    await expect(prisma.player.update({ where: { id: "p2" }, data: { contactEmail: "x@example.com" } })).rejects.toThrow();
    await expect(prisma.player.update({ where: { id: "p2" }, data: { contactEmailType: "PLAYER" } })).rejects.toThrow();
    expect(await row("p2")).toMatchObject({ contactEmail: null, contactEmailType: null });
  });
});

describe("M13B P1 — set / edit / clear (OWNER, ADMIN)", () => {
  it("set (normalized), edit, switch type, clear — the linked account's email is never touched", async () => {
    expect(await getContact("p1")).toMatchObject({ status: 200, body: { contact: null, linkedAccount: { linked: true, verified: true } } });
    const r = await putContact("p1", { email: "  Guardian.Of.Pat+Soccer@Example.com ", type: "GUARDIAN" });
    expect(r).toMatchObject({ status: 200, body: { contact: { email: SECRET_A, type: "GUARDIAN" } } });
    expect(JSON.stringify(r.body)).not.toContain("player@example.test"); // the account address is never shown
    expect(await row("p1")).toMatchObject({ contactEmail: SECRET_A, contactEmailType: "GUARDIAN" });
    signIn("admin");
    expect((await putContact("p1", { email: "new@example.com", type: "PLAYER" })).body).toMatchObject({ contact: { email: "new@example.com", type: "PLAYER" } });
    expect((await putContact("p1", { email: "" })).body).toMatchObject({ contact: null });
    expect(await row("p1")).toMatchObject({ contactEmail: null, contactEmailType: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-player" } })).email).toBe("player@example.test");
  });

  it("validation: invalid, CR/LF, control characters, missing / bad type → 400, nothing written", async () => {
    for (const body of [
      { email: "nope", type: "PLAYER" },
      { email: "a@b.com\r\nBcc: evil@example.com", type: "PLAYER" },
      { email: "a@b.com\u0000", type: "PLAYER" },
      { email: "a@b.com" },
      { email: "a@b.com", type: "COACH" },
      { email: 42, type: "PLAYER" },
    ]) {
      expect((await putContact("p2", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await putContact("p2", {})).status).toBe(400); // email key required (explicit clear is { email: null })
    expect(await row("p2")).toMatchObject({ contactEmail: null, contactEmailType: null });
  });
});

describe("M13B P1 — authorization and isolation (no existence leakage)", () => {
  it("MEMBER, other organization, other group, unknown id → identical 404; signed out → 401", async () => {
    await putContact("p2", { email: SECRET_B, type: "PLAYER" });
    const notFound = async (r: Promise<{ status: number; body: Record<string, unknown> }>) => {
      const x = await r;
      expect(x.status).toBe(404);
      expect(JSON.stringify(x.body)).not.toContain(SECRET_B);
    };
    signIn("member");
    await notFound(getContact("p2"));
    await notFound(putContact("p2", { email: "x@example.com", type: "PLAYER" }));
    signIn("other");
    await notFound(getContact("p2")); // not their organization
    await notFound(getContact("p2", "o2", "g2")); // their group, but not their player
    signIn("owner");
    await notFound(getContact("px")); // same organization, other group
    await notFound(putContact("px", { email: "x@example.com", type: "PLAYER" }));
    await notFound(getContact("does-not-exist"));
    signIn(null);
    expect((await getContact("p2")).status).toBe(401);
    expect(await row("p2")).toMatchObject({ contactEmail: SECRET_B });
    expect(await row("px")).toMatchObject({ contactEmail: null });
  });
});

describe("M13B P1 — recipient resolution (no sending)", () => {
  it("contact first (with type), verified account fallback, unverified excluded, else NO_EMAIL; one group only", async () => {
    await putContact("p2", { email: SECRET_B, type: "PLAYER" });
    await putContact("p4", { email: SECRET_A, type: "GUARDIAN" });
    const r = await loadRecipients("g", ["p1", "p2", "p3", "p4", "px", "p9"]);
    expect(Object.fromEntries(r)).toEqual({
      p1: { kind: "ACCOUNT", email: "player@example.test" },
      p2: { kind: "CONTACT", email: SECRET_B, contactType: "PLAYER" },
      p3: { kind: "NO_EMAIL" }, // linked, but the account email is unverified
      p4: { kind: "CONTACT", email: SECRET_A, contactType: "GUARDIAN" },
    }); // px / p9 belong to other groups → absent
    expect(network).toBe(0);
  });
});

describe("M13B P1 — contact emails never leave organizer-only paths", () => {
  async function withContacts() {
    await putContact("p1", { email: SECRET_A, type: "GUARDIAN" });
    await putContact("p2", { email: SECRET_B, type: "PLAYER" });
  }
  const noSecrets = (label: string, v: unknown) => {
    const s = JSON.stringify(v);
    expect(s, label).not.toContain(SECRET_A);
    expect(s, label).not.toContain(SECRET_B);
    expect(s, label).not.toMatch(/contactEmail/);
  };

  it("organizer and member rosters, player create / update responses", async () => {
    await withContacts();
    noSecrets("owner roster", (await call(playersRoute.GET(json("GET"), g()))).body);
    noSecrets("player update", (await call(playerRoute.PATCH(json("PATCH", { firstName: "Patricia" }), gp("p1")))).body);
    noSecrets("player create", (await call(playersRoute.POST(json("POST", { firstName: "New", lastName: "One", position: "MIDFIELDER", rating: "GOOD" }), g()))).body);
    signIn("member");
    noSecrets("member roster", (await call(playersRoute.GET(json("GET"), g()))).body);
  });

  it("public roster API, published teams, share-link view, player match view and My Games", async () => {
    await withContacts();
    signIn(null);
    noSecrets("public players API", (await call(publicPlayersRoute.GET(json("GET"), g()))).body);
    signIn("owner");
    const match = await prisma.match.create({ data: { id: "m1", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00" } });
    const gen = await call(generateRoute.POST(json("POST", { teamCount: 2, date: "2099-06-03", selectedIds: ["p1", "p2", "p3", "p4"], matchId: match.id }), g()));
    noSecrets("generate response", gen.body);
    expect((await call(publishRoute.POST(json("POST", { date: "2099-06-03", teams: gen.body.teams, matchId: match.id }), g()))).status).toBe(200);
    noSecrets("published snapshot (source of Telegram posts and AI recap facts)", await prisma.teamGeneration.findMany({ select: { teamsJson: true } }));
    const token = generateToken();
    await prisma.groupShareLink.create({ data: { groupId: "g", tokenHash: hashToken(token) } });
    noSecrets("share-link view", await resolveShareView(token));
    noSecrets("player match view", await buildPlayerMatchView({ id: "g", name: "Wednesday Soccer", sportKey: "soccer", organizationName: "Org" }, match.id));
    noSecrets("My Games", await loadMyGames("u-player"));
  });

  it("existing attendance flow unchanged for a player who has a contact email", async () => {
    await withContacts();
    await prisma.match.create({ data: { id: "mw", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00" } });
    signIn("player");
    expect((await call(ownAttendanceRoute.POST(json("POST", { status: "PLAYING" }), { params: Promise.resolve({ matchId: "mw" }) }))).status).toBe(200);
    expect(await prisma.attendanceResponse.findUniqueOrThrow({ where: { matchId_playerId: { matchId: "mw", playerId: "p1" } } })).toMatchObject({ participantStatus: "PLAYING", participantSource: "WEB" });
    expect(network).toBe(0);
  });

  it("deleting a player removes its contact data with the row", async () => {
    await withContacts();
    expect((await call(playerRoute.DELETE(json("DELETE"), gp("p2")))).status).toBe(200);
    expect(await prisma.player.count({ where: { contactEmail: SECRET_B } })).toBe(0);
  });
});
