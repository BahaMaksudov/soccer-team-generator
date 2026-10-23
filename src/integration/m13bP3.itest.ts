/**
 * M13B P3 — email suppression and unsubscribe. REAL DATABASE (guarded local test DB
 * only). Emails go only to the in-memory test outbox; the network is forbidden.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as previewApi from "@/app/api/email/unsubscribe/preview/route";
import * as confirmApi from "@/app/api/email/unsubscribe/route";
import * as oneClickApi from "@/app/api/email/unsubscribe/one-click/route";
import * as rsvpPreviewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-preview/route";
import { issueUnsubscribeToken, recordGlobalSuppression, suppressedFor, UNSUBSCRIBE_TOKEN_TTL_DAYS } from "@/lib/emailSuppression";
import { generateToken } from "@/lib/secureToken";
import { preparePasswordReset, deliverResetDispatch } from "@/lib/passwordReset";
import { sendVerificationEmail } from "@/lib/email";
import { testOutbox } from "@/lib/email/transport";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
/** M13B P6 — contacts seeded directly carry an organizer confirmation (unconfirmed contacts are never emailed). */
const AUTH_AT = new Date("2026-01-01T00:00:00Z");
let network = 0;
const originalFetch = global.fetch;
const ORIGIN = { Origin: "http://itest.local" };

const jsonReq = (url: string, body: unknown, headers: Record<string, string> = ORIGIN) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const res = async (r: Promise<Response> | Response) => {
  const x = await r;
  return { status: x.status, body: (await x.json().catch(() => ({}))) as Record<string, unknown> };
};
const preview = (token: unknown) => res(previewApi.POST(jsonReq("http://itest.local/api/email/unsubscribe/preview", { token })));
const confirm = (token: unknown, headers?: Record<string, string>) => res(confirmApi.POST(jsonReq("http://itest.local/api/email/unsubscribe", { token }, headers)));
const oneClick = (token: string, body = "List-Unsubscribe=One-Click", type = "application/x-www-form-urlencoded") =>
  res(oneClickApi.POST(new Request(`http://itest.local/api/email/unsubscribe/one-click?t=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": type }, body })));
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const rsvp = async (matchId = "m", org = "o", group = "g") => {
  const r = await rsvpPreviewRoute.GET(new Request("http://itest.local/api/x"), { params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
  return (await r.json()) as { recipients: Array<{ playerId: string; status: string }>; counts: { willSend: number; byStatus: Record<string, number> } };
};
const statusOf = async (matchId = "m", org?: string, group?: string) => Object.fromEntries((await rsvp(matchId, org, group)).recipients.map((r) => [r.playerId, r.status]));
const optOuts = () => prisma.organizationEmailOptOut.findMany({ orderBy: { email: "asc" }, select: { organizationId: true, email: true, source: true } });

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PasswordResetToken","EmailVerificationToken","AttendanceResponse","Match","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({
    data: [
      { id: "u-owner", email: "owner@example.test", name: "owner", passwordHash: "$2b$12$abcdefghijklmnopqrstuuJ0dQ7cBWyH1u3oA6c7dQkS9eX8mGkW", emailVerifiedAt: VERIFIED },
      { id: "u-owner2", email: "owner2@example.test", name: "owner2", passwordHash: null, emailVerifiedAt: VERIFIED },
    ],
  });
  await prisma.organization.createMany({ data: [{ id: "o", name: "Wednesday Club", slug: "o", plan: "LEGACY" }, { id: "o2", name: "Other Club", slug: "o2", plan: "LEGACY" }] });
  await prisma.group.createMany({ data: [{ id: "g", organizationId: "o", name: "G", slug: "g", sportKey: "soccer", timezone: TZ }, { id: "g2", organizationId: "o2", name: "G2", slug: "g2", sportKey: "soccer", timezone: TZ }] });
  await prisma.organizationMembership.createMany({ data: [{ userId: "u-owner", organizationId: "o", role: "OWNER" }, { userId: "u-owner2", organizationId: "o2", role: "OWNER" }] });
  const P = (id: string, groupId: string, firstName: string, contactEmail: string | null) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail, contactEmailType: contactEmail ? ("PLAYER" as const) : null, contactAuthorizedAt: contactEmail ? AUTH_AT : null });
  await prisma.player.createMany({
    data: [P("p1", "g", "Ava", "ava@example.com"), P("p2", "g", "Ben", "ben@example.com"), P("p3", "g", "Cal", "cal@example.com"), P("p4", "g", "Dee", "dee@example.com"), P("p5", "g", "Eli", "eli@example.com"), P("q1", "g2", "Ava", "ava@example.com")],
  });
  await prisma.match.createMany({ data: [{ id: "m", groupId: "g", date: new Date("2099-06-03") }, { id: "m2", groupId: "g2", date: new Date("2099-06-03") }] });
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
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@tbp.itest>");
});
beforeEach(async () => {
  network = 0;
  testOutbox.clear();
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("M13B P3 — token lifecycle", () => {
  it("only the SHA-256 of a token is stored; the raw token appears nowhere in the database", async () => {
    const { token, expiresAt } = await issueUnsubscribeToken("o", "  Ava@Example.COM ");
    const rows = await prisma.emailUnsubscribeToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: "o", email: "ava@example.com", purpose: "RSVP_INVITATION", usedAt: null });
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(Math.round((expiresAt.getTime() - rows[0].createdAt.getTime()) / 86_400_000)).toBe(UNSUBSCRIBE_TOKEN_TTL_DAYS);
  });

  it("preview (page load) is read-only and generic: org name + masked address only", async () => {
    const { token } = await issueUnsubscribeToken("o", "ava@example.com");
    for (let i = 0; i < 3; i++) expect(await preview(token)).toMatchObject({ status: 200, body: { state: "valid", organizationName: "Wednesday Club", maskedEmail: "a•••@example.com" } });
    expect(await optOuts()).toEqual([]);
    expect((await prisma.emailUnsubscribeToken.findFirstOrThrow()).usedAt).toBeNull();
    expect(JSON.stringify((await preview(token)).body)).not.toContain("ava@");
    expect(await preview("nope")).toMatchObject({ status: 404, body: { state: "invalid" } });
    expect(await preview(generateToken())).toMatchObject({ status: 404, body: { state: "invalid" } }); // forged / unknown
  });

  it("website confirm: same-origin JSON only; opts out ONE organization; idempotent; replay changes nothing", async () => {
    const { token } = await issueUnsubscribeToken("o", "ava@example.com");
    expect((await confirm(token, {})).status).toBe(403); // cross-site
    expect(await optOuts()).toEqual([]);
    expect(await confirm(token)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await optOuts()).toEqual([{ organizationId: "o", email: "ava@example.com", source: "LINK" }]);
    const used = (await prisma.emailUnsubscribeToken.findFirstOrThrow()).usedAt;
    expect(used).not.toBeNull();
    expect(await confirm(token)).toMatchObject({ status: 200, body: { ok: true } }); // replay
    expect(await optOuts()).toHaveLength(1);
    expect((await prisma.emailUnsubscribeToken.findFirstOrThrow()).usedAt).toEqual(used);
    expect((await preview(token)).body).toMatchObject({ state: "used" });
  });

  it("forged and expired tokens never opt anyone out", async () => {
    expect(await confirm(generateToken())).toMatchObject({ status: 404, body: { code: "INVALID" } });
    const { token } = await issueUnsubscribeToken("o", "ava@example.com", new Date(Date.now() - (UNSUBSCRIBE_TOKEN_TTL_DAYS + 1) * 86_400_000));
    expect(await preview(token)).toMatchObject({ status: 200, body: { state: "expired" } });
    expect(await confirm(token)).toMatchObject({ status: 410, body: { code: "EXPIRED" } });
    expect((await oneClick(token)).status).toBe(410);
    expect(await optOuts()).toEqual([]);
  });

  it("concurrent confirmations (website + one-click) create exactly one opt-out", async () => {
    const { token } = await issueUnsubscribeToken("o", "ava@example.com");
    const results = await Promise.all([...Array.from({ length: 6 }, () => confirm(token)), ...Array.from({ length: 6 }, () => oneClick(token))]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.organizationEmailOptOut.count()).toBe(1);
  });
});

describe("M13B P3 — RFC 8058 one-click", () => {
  it("only an exact 'List-Unsubscribe=One-Click' form POST unsubscribes; there is no GET handler", async () => {
    const { token } = await issueUnsubscribeToken("o", "ben@example.com");
    expect("GET" in oneClickApi).toBe(false); // a GET (link scanner / prefetch) is 405 and never mutates
    expect("GET" in confirmApi).toBe(false);
    expect((await oneClick(token, "List-Unsubscribe=Yes")).status).toBe(400);
    expect((await oneClick(token, '{"List-Unsubscribe":"One-Click"}', "application/json")).status).toBe(400);
    expect(await optOuts()).toEqual([]);
    expect(await oneClick(token)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await optOuts()).toEqual([{ organizationId: "o", email: "ben@example.com", source: "ONE_CLICK" }]);
    expect((await oneClick(generateToken())).status).toBe(404);
  });
});

describe("M13B P3 — suppression in the recipient preview", () => {
  it("SUPPRESSED for a global hard bounce, a spam complaint and this organization's opt-out — no reason exposed", async () => {
    await recordGlobalSuppression("BEN@example.com", "HARD_BOUNCE", "manual");
    await recordGlobalSuppression("cal@example.com", "SPAM_COMPLAINT", "manual");
    const { token } = await issueUnsubscribeToken("o", "Dee@Example.com"); // casing must not matter
    await confirm(token);
    expect(await statusOf()).toEqual({ p1: "WILL_SEND", p2: "SUPPRESSED", p3: "SUPPRESSED", p4: "SUPPRESSED", p5: "WILL_SEND" });
    const raw = JSON.stringify(await rsvp());
    for (const s of ["HARD_BOUNCE", "SPAM_COMPLAINT", "BOUNCE", "COMPLAINT", "ben@", "cal@", "dee@"]) expect(raw, s).not.toContain(s);
  });

  it("an opt-out is per organization; global suppression applies everywhere; other organizations' opt-outs are invisible", async () => {
    const { token } = await issueUnsubscribeToken("o2", "ava@example.com");
    await confirm(token);
    expect((await statusOf()).p1).toBe("WILL_SEND"); // org o unaffected by o2's opt-out
    signIn("owner2");
    expect((await statusOf("m2", "o2", "g2")).q1).toBe("SUPPRESSED");
    expect([...(await suppressedFor("o", ["ava@example.com"]))]).toEqual([]);
    await recordGlobalSuppression("ava@example.com", "HARD_BOUNCE", "manual");
    signIn("owner");
    expect((await statusOf()).p1).toBe("SUPPRESSED");
  });

  it("precedence: override > answered > invalid contact > no email > suppressed > over limit > will send", async () => {
    for (const e of ["ava@example.com", "ben@example.com", "cal@example.com"]) await recordGlobalSuppression(e, "HARD_BOUNCE", "manual");
    await prisma.attendanceResponse.createMany({
      data: [
        { matchId: "m", groupId: "g", playerId: "p1", overrideStatus: "PLAYING", overrideAt: new Date(), overrideByUserId: "u-owner" },
        { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "MAYBE", participantSource: "PERSONAL_LINK", participantRespondedAt: new Date() },
      ],
    });
    await prisma.player.update({ where: { id: "p4" }, data: { contactEmail: null, contactEmailType: null, contactAuthorizedAt: null } });
    await prisma.$executeRawUnsafe(`UPDATE "Player" SET "contactEmail" = 'broken' WHERE id = 'p5'`);
    expect(await statusOf()).toEqual({ p1: "ORGANIZER_OVERRIDE", p2: "ALREADY_ANSWERED", p3: "SUPPRESSED", p4: "NO_EMAIL", p5: "INVALID_CONTACT" });
  });

  it("suppressed recipients never use plan capacity (OVER_LIMIT counts only sendable ones)", async () => {
    await prisma.organization.update({ where: { id: "o" }, data: { plan: "FREE" } });
    await prisma.player.createMany({
      data: Array.from({ length: 18 }, (_, i) => ({ id: `z${String(i).padStart(2, "0")}`, groupId: "g", firstName: `Z${String(i).padStart(2, "0")}`, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail: `z${i}@example.com`, contactEmailType: "PLAYER" as const, contactAuthorizedAt: AUTH_AT })),
    });
    // 23 sendable before suppression; Free ceiling 20/day.
    expect((await rsvp()).counts.byStatus.OVER_LIMIT).toBe(3);
    for (const e of ["ava@example.com", "ben@example.com", "cal@example.com"]) await recordGlobalSuppression(e, "SPAM_COMPLAINT", "manual");
    expect((await rsvp()).counts).toMatchObject({ willSend: 20, byStatus: { SUPPRESSED: 3, OVER_LIMIT: 0 } });
  });
});

describe("M13B P3 — account emails are never suppressed", () => {
  it("password reset and verification emails still go to a suppressed / opted-out address", async () => {
    await recordGlobalSuppression("owner@example.test", "HARD_BOUNCE", "manual");
    const { token } = await issueUnsubscribeToken("o", "owner@example.test");
    await confirm(token);
    await deliverResetDispatch(await preparePasswordReset("owner@example.test"));
    await sendVerificationEmail({ to: "owner@example.test", name: "owner", token: generateToken(), expiresAt: new Date(Date.now() + 3_600_000) });
    expect(testOutbox.sent.map((m) => m.to)).toEqual(["owner@example.test", "owner@example.test"]);
    expect(testOutbox.sent.every((m) => !m.headers)).toBe(true);
    expect(network).toBe(0);
  });
});
