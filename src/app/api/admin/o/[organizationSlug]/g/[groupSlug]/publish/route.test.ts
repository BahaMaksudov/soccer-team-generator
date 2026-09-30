import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockUpsert = vi.fn();
const mockDeleteMany = vi.fn();
const mockPollFindUnique = vi.fn();
const mockPollUpdate = vi.fn();
// Phase 2D.6E.6C — Publish validates submitted player ids against the
// active Group. Default: every requested id is owned by the queried
// Group (so the selector-focused tests below are unaffected); the
// dedicated ownership tests install an explicit ownership table.
type PlayerQuery = { where: { groupId: string; id: { in: string[] } } };
const ownAll = async ({ where }: PlayerQuery) =>
  where.id.in.map((id) => ({ id, firstName: `F-${id}`, lastName: `L-${id}`, position: "MIDFIELDER", rating: "GOOD", stamina: 3 }));
const mockPlayerFindMany = vi.fn(ownAll);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findMany: (...a: [PlayerQuery]) => mockPlayerFindMany(...a) },
    teamGeneration: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    telegramPoll: {
      findUnique: (...args: unknown[]) => mockPollFindUnique(...args),
      update: (...args: unknown[]) => mockPollUpdate(...args),
    },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST, DELETE } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

const GROUP_B = { id: "group-b", name: "B", slug: "group-b", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_B = {
  user: { id: "u2", email: "b@example.com", name: null },
  organization: { id: "org-b", name: "Org B", slug: "org-b" },
  membership: { id: "m2", role: "OWNER" as const },
  groups: [GROUP_B],
  activeGroup: GROUP_B,
};

const SAMPLE_TEAMS = [{ teamNumber: 1, players: [{ id: "p1", firstName: "A", lastName: "B" }] }];

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function publishReq(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockPlayerFindMany.mockImplementation(ownAll);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  global.fetch = vi.fn().mockRejectedValue(new Error("real Telegram API must never be called in tests"));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("POST canonical publish — success, server-stamped tenancy", () => {
  it("resolves via the URL pair; upsert selector and create payload both use the URL-resolved active group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });

    const call = mockUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ groupId_date: { groupId: "group-a", date: expect.any(Date) } });
    expect(call.create).toEqual(expect.objectContaining({ groupId: "group-a", teamsJson: expect.any(String) }));
    expect(call.update).not.toHaveProperty("groupId");
  });
});

describe("POST canonical publish — date-only value is persisted exactly (Phase 2D.6E.3B)", () => {
  it("the preview's 2026-10-05T00:00:00.000Z is upserted as TeamGeneration.date 2026-10-05T00:00:00.000Z", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    const res = await POST(publishReq({ date: "2026-10-05T00:00:00.000Z", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    const call = mockUpsert.mock.calls[0][0];
    expect(call.where.groupId_date.date.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(call.create.date.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
});

describe("POST canonical publish — same-date, different-Group isolation", () => {
  it("Group A and Group B publishing the same date use structurally different (groupId, date) selectors", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-a" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    const callA = mockUpsert.mock.calls[0][0];
    expect(callA.where.groupId_date.groupId).toBe("group-a");

    vi.clearAllMocks();
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockUpsert.mockResolvedValue({ id: "gen-b" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-b", "group-b"));
    const callB = mockUpsert.mock.calls[0][0];
    expect(callB.where.groupId_date.groupId).toBe("group-b");

    expect(callA.where.groupId_date.groupId).not.toBe(callB.where.groupId_date.groupId);
  });
});

describe("POST canonical publish — same-Group overwrite semantics", () => {
  it("republishing the same URL + same date reuses the identical (groupId, date) selector (upsert, not a new row)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-a" });

    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    const firstCall = mockUpsert.mock.calls[0][0];

    await POST(publishReq({ date: "2026-09-28", teams: [{ teamNumber: 1, players: [{ id: "p2", firstName: "C", lastName: "D" }] }] }), ctx("org-a", "group-a"));
    const secondCall = mockUpsert.mock.calls[1][0];

    expect(firstCall.where).toEqual(secondCall.where);
    expect(secondCall.update.teamsJson).not.toBe(firstCall.create.teamsJson);
  });
});

describe("POST canonical publish — malicious tenant fields ignored", () => {
  it("a body groupId cannot influence the selector or create payload", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, groupId: "group-b" }), ctx("org-a", "group-a"));

    const call = mockUpsert.mock.calls[0][0];
    expect(call.where.groupId_date.groupId).toBe("group-a");
    expect(call.create.groupId).toBe("group-a");
  });

  it("a body organizationId cannot influence tenant resolution", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    await POST(
      publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, organizationId: "org-b" }),
      ctx("org-a", "group-a")
    );

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    const call = mockUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
  });
});

describe("POST canonical publish — invalid tenant fails closed before any TeamGeneration write", () => {
  it("unknown Organization -> generic canonical failure, upsert never called", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group -> identical generic canonical failure, upsert never called", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("unknown Organization and foreign Group produce the identical status + body (no existence leak)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("UNAUTHENTICATED still maps to 401", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
  });
});

describe("POST canonical publish — same Group slug across Organizations remains isolated", () => {
  it("org-a/indoor-soccer and org-b/indoor-soccer resolve and upsert independently", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    mockUpsert.mockResolvedValue({ id: "gen-a" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "indoor-soccer"));
    expect(mockUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId_date: { groupId: "group-a", date: expect.any(Date) } } })
    );

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    mockUpsert.mockResolvedValue({ id: "gen-b" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-b", "indoor-soccer"));
    expect(mockUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId_date: { groupId: "group-b", date: expect.any(Date) } } })
    );
  });
});

describe("DELETE canonical publish — cross-tenant delete protection", () => {
  it("scopes deleteMany to both the date range AND the URL-resolved active group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockDeleteMany.mockResolvedValue({ count: 1 });

    const res = await DELETE(new Request("http://localhost?date=2026-09-28"), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupId: "group-a" }) })
    );
  });

  it("cannot remove Group B's generation for the same date — Group A's scoped deleteMany naturally matches nothing", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    // Simulates: the only row for this date belongs to group-b, so the
    // groupId-scoped deleteMany matches zero rows.
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const res = await DELETE(new Request("http://localhost?date=2026-09-28"), ctx("org-a", "group-a"));
    const data = await res.json();
    expect(data.deleted).toBe(0);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupId: "group-a" }) })
    );
  });

  it("Delete Published Teams never touches TelegramPoll or the Telegram API (Phase 2D.6D.5E.3)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockDeleteMany.mockResolvedValue({ count: 1 });

    const res = await DELETE(new Request("http://localhost?date=2026-09-28"), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);

    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(mockPollUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid date without deleting", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    const res = await DELETE(new Request("http://localhost?date=09/28/2026"), ctx("org-a", "group-a"));
    expect(res.status).toBe(400);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("a fail-closed tenant resolution never reaches deleteMany", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await DELETE(new Request("http://localhost?date=2026-09-28"), ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

describe("POST canonical publish — Telegram poll actions are server-hard-disabled, not merely unused by the UI", () => {
  it("a client-supplied pollId is rejected with 400 BEFORE any TeamGeneration write or Telegram lookup", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    const res = await POST(
      publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, pollId: "poll-1" }),
      ctx("org-a", "group-a")
    );

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a malicious/foreign-group pollId is rejected the same way — never reaches the ownership check, never leaks whether it belongs to another Group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    // If this ever reached the shared ownership check, it would look
    // like a real foreign-Group poll — but it must never get there.
    mockPollFindUnique.mockResolvedValue({ pollId: "poll-1", groupId: "group-b", chatId: 111n, messageId: 42n });

    const res = await POST(
      publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, pollId: "poll-1", closePoll: true, postToTelegram: true }),
      ctx("org-a", "group-a")
    );

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(mockPollUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a rejected pollId request still resolves tenancy from the URL first — the 400 is a payload rejection, not a tenant-resolution bypass", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, pollId: "poll-1" }), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("omitting pollId entirely (the canonical UI's actual behavior) publishes normally and never touches Telegram", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }), ctx("org-a", "group-a"));
    const data = await res.json();

    // Phase 2D.6D.5E.5 — Publish is DB-only: the response is just the
    // saved generation (no pollStatus/telegramTeamsPosted any more).
    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, id: "gen-1" });
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("closePoll/postToTelegram without a pollId are inert: teams are saved, nothing Telegram-related happens (Phase 2D.6D.5E.5)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    const res = await POST(
      publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, closePoll: true, postToTelegram: true }),
      ctx("org-a", "group-a")
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "gen-1" });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(mockPollUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST canonical publish — submitted players must belong to the active Group (Phase 2D.6E.6C)", () => {
  // Explicit ownership table, applied like the real query: groupId AND id IN (...)
  // Authoritative Player rows (what the database holds).
  const DB: Record<string, { groupId: string; firstName: string; lastName: string; position: string; rating: string; stamina: number }> = {
    pa1: { groupId: "group-a", firstName: "Anna", lastName: "Alpha", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5 },
    pa2: { groupId: "group-a", firstName: "Adam", lastName: "Alpha", position: "DEFENDER", rating: "GOOD", stamina: 4 },
    pb1: { groupId: "group-b", firstName: "Bea", lastName: "Beta", position: "DEFENDER", rating: "FAIR", stamina: 2 },
    pb2: { groupId: "group-b", firstName: "Bo", lastName: "Beta", position: "FORWARD", rating: "VERY_GOOD", stamina: 3 },
    pb3: { groupId: "group-b", firstName: "Bix", lastName: "Beta", position: "MIDFIELDER", rating: "GOOD", stamina: 1 },
  };
  const ownership = async ({ where }: PlayerQuery) =>
    where.id.in
      .filter((id) => DB[id]?.groupId === where.groupId)
      .map((id) => {
        const { groupId: _g, ...fields } = DB[id];
        return { id, ...fields };
      });
  const canonical = (id: string) => {
    const { groupId: _g, ...fields } = DB[id];
    return { id, ...fields };
  };
  const team = (n: number, ids: string[]) => ({
    teamNumber: n,
    players: ids.map((id) => ({ id, firstName: `First-${id}`, lastName: `Last-${id}`, position: "DEFENDER" })),
  });
  const GENERIC = JSON.stringify({ error: "One or more players are invalid or unavailable." });

  beforeEach(() => {
    mockPlayerFindMany.mockImplementation(ownership);
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockUpsert.mockResolvedValue({ id: "gen-b" });
  });

  it("all Group B players → published; ownership query is scoped to Group B and runs before the upsert", async () => {
    const res = await POST(
      publishReq({ date: "2026-09-23", teams: [team(1, ["pb1"]), team(2, ["pb2"])] }),
      ctx("org-b", "group-b")
    );
    expect(res.status).toBe(200);
    expect(mockPlayerFindMany).toHaveBeenCalledWith({
      where: { groupId: "group-b", id: { in: ["pb1", "pb2"] } },
      select: { id: true, firstName: true, lastName: true, position: true, rating: true, stamina: true },
    });
    expect(mockPlayerFindMany.mock.invocationCallOrder[0]).toBeLessThan(mockUpsert.mock.invocationCallOrder[0]);
    // Same-date publish stays Group-scoped.
    expect(mockUpsert.mock.calls[0][0].where.groupId_date.groupId).toBe("group-b");
  });

  it("a Group A player through Group B Publish → 400 generic, no TeamGeneration upsert, no foreign details", async () => {
    const res = await POST(publishReq({ date: "2026-09-23", teams: [team(1, ["pa1"])] }), ctx("org-b", "group-b"));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(GENERIC);
    expect(text).not.toMatch(/pa1|group-a|First-|Last-/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a mixed Group A + Group B team → 400 generic, the whole Publish rejected, no upsert", async () => {
    const res = await POST(
      publishReq({ date: "2026-09-23", teams: [team(1, ["pb1", "pa1"]), team(2, ["pb2"])] }),
      ctx("org-b", "group-b")
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a nonexistent player id → 400 generic, indistinguishable from a foreign one, no upsert", async () => {
    const res = await POST(publishReq({ date: "2026-09-23", teams: [team(1, ["pb1", "nope"])] }), ctx("org-b", "group-b"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["a player without an id", [{ teamNumber: 1, players: [{ firstName: "No", lastName: "Id" }] }]],
    ["a player with an empty id", [{ teamNumber: 1, players: [{ id: "  ", firstName: "E", lastName: "M" }] }]],
    ["a non-string id", [{ teamNumber: 1, players: [{ id: 42, firstName: "N", lastName: "S" }] }]],
    ["the same player on two teams", [team(1, ["pb1"]), team(2, ["pb1"])]],
    ["no players at all", [{ teamNumber: 1, players: [] }]],
  ])("%s → 400 generic before any Player query or upsert", async (_label, teams) => {
    const res = await POST(publishReq({ date: "2026-09-23", teams }), ctx("org-b", "group-b"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a legitimate Generate → Preview payload still publishes, stored as the authoritative snapshot", async () => {
    // Exactly what canonical Generate returns: the six snapshot fields per player.
    const teams = [
      { teamNumber: 1, players: [canonical("pb1")] },
      { teamNumber: 2, players: [canonical("pb2")] },
    ];
    const res = await POST(publishReq({ date: "2026-10-05T00:00:00.000Z", teams }), ctx("org-b", "group-b"));
    expect(res.status).toBe(200);
    // Unchanged when the client sent the true values.
    expect(JSON.parse(mockUpsert.mock.calls[0][0].create.teamsJson)).toEqual(teams);
  });
});

describe("POST canonical publish — server-authoritative snapshot (Phase 2D.6E.6D)", () => {
  const DB: Record<string, { groupId: string; firstName: string; lastName: string; position: string; rating: string; stamina: number }> = {
    pa1: { groupId: "group-a", firstName: "Anna", lastName: "Alpha", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5 },
    pb1: { groupId: "group-b", firstName: "Bea", lastName: "Beta", position: "DEFENDER", rating: "FAIR", stamina: 2 },
    pb2: { groupId: "group-b", firstName: "Bo", lastName: "Beta", position: "FORWARD", rating: "VERY_GOOD", stamina: 3 },
    pb3: { groupId: "group-b", firstName: "Bix", lastName: "Beta", position: "MIDFIELDER", rating: "GOOD", stamina: 1 },
    pb4: { groupId: "group-b", firstName: "Bel", lastName: "Beta", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 4 },
  };
  const rows = async ({ where }: PlayerQuery) =>
    // Deliberately returned in a DIFFERENT order than requested (DB order).
    Object.keys(DB)
      .filter((id) => where.id.in.includes(id) && DB[id].groupId === where.groupId)
      .map((id) => {
        const { groupId: _g, ...fields } = DB[id];
        return { id, ...fields };
      });
  const canonical = (id: string) => {
    const { groupId: _g, ...fields } = DB[id];
    return { id, ...fields };
  };
  const stored = () => JSON.parse(mockUpsert.mock.calls[0][0].create.teamsJson);
  const GENERIC = JSON.stringify({ error: "One or more players are invalid or unavailable." });
  const publish = (teams: unknown) =>
    POST(publishReq({ date: "2026-10-12", teams }), ctx("org-b", "group-b"));

  beforeEach(() => {
    mockPlayerFindMany.mockImplementation(rows);
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockUpsert.mockResolvedValue({ id: "gen-b" });
  });

  it("forged first/last name → publish succeeds, DB name stored, forged name absent", async () => {
    const res = await publish([{ teamNumber: 1, players: [{ id: "pb1", firstName: "FORGED", lastName: "PLAYER" }] }]);
    expect(res.status).toBe(200);
    expect(stored()[0].players[0]).toEqual(canonical("pb1"));
    expect(mockUpsert.mock.calls[0][0].create.teamsJson).not.toMatch(/FORGED|PLAYER/);
  });

  it("forged position → DB position stored", async () => {
    await publish([{ teamNumber: 1, players: [{ id: "pb2", firstName: "Bo", lastName: "Beta", position: "GOALKEEPER" }] }]);
    expect(stored()[0].players[0].position).toBe("FORWARD");
  });

  it("forged rating and stamina → DB values stored", async () => {
    await publish([{ teamNumber: 1, players: [{ id: "pb1", rating: "EXCELLENT", stamina: 999 }] }]);
    expect(stored()[0].players[0]).toMatchObject({ rating: "FAIR", stamina: 2 });
    expect(mockUpsert.mock.calls[0][0].create.teamsJson).not.toContain("999");
  });

  it("injected player keys and team keys are not persisted; snapshot is exactly the six allowlisted fields", async () => {
    await publish([
      {
        teamNumber: 1,
        teamInjected: "bad",
        players: [{ id: "pb1", someInjectedKey: "bad", groupId: "group-a", isActive: false, telegramUserId: "123", __proto__x: 1 }],
      },
    ]);
    const t = stored()[0];
    expect(Object.keys(t).sort()).toEqual(["players", "teamNumber"]);
    expect(Object.keys(t.players[0]).sort()).toEqual(["firstName", "id", "lastName", "position", "rating", "stamina"]);
    expect(mockUpsert.mock.calls[0][0].create.teamsJson).not.toMatch(/someInjectedKey|teamInjected|group-a|telegramUserId|isActive|bad/);
  });

  it("preserves team membership, team numbers and in-team order exactly (no rebalancing, even when DB returns rows in another order)", async () => {
    await publish([
      { teamNumber: 1, players: [{ id: "pb3" }, { id: "pb1" }] },
      { teamNumber: 2, players: [{ id: "pb4" }, { id: "pb2" }] },
    ]);
    expect(stored()).toEqual([
      { teamNumber: 1, players: [canonical("pb3"), canonical("pb1")] },
      { teamNumber: 2, players: [canonical("pb4"), canonical("pb2")] },
    ]);
    // update payload is the same snapshot as create
    expect(mockUpsert.mock.calls[0][0].update.teamsJson).toBe(mockUpsert.mock.calls[0][0].create.teamsJson);
  });

  it("foreign player (even with forged fields) → 400 generic, no upsert", async () => {
    const res = await publish([{ teamNumber: 1, players: [{ id: "pa1", firstName: "Bea", lastName: "Beta" }] }]);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("mixed Group A + Group B → 400 generic, no upsert", async () => {
    const res = await publish([{ teamNumber: 1, players: [{ id: "pb1" }, { id: "pa1" }] }]);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("duplicate player id → 400 generic, no Player query, no upsert", async () => {
    const res = await publish([{ teamNumber: 1, players: [{ id: "pb1" }] }, { teamNumber: 2, players: [{ id: "pb1" }] }]);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(GENERIC);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("the stored snapshot is fixed at Publish time: later Player-row changes don't alter it", async () => {
    await publish([{ teamNumber: 1, players: [{ id: "pb1" }] }]);
    const persisted = mockUpsert.mock.calls[0][0].create.teamsJson;
    DB.pb1.firstName = "Renamed-Later";
    DB.pb1.stamina = 5;
    // The persisted value is a self-contained string; nothing re-reads Player rows.
    expect(JSON.parse(persisted)[0].players[0]).toMatchObject({ firstName: "Bea", stamina: 2 });
    expect(persisted).not.toContain("Renamed-Later");
    DB.pb1.firstName = "Bea";
    DB.pb1.stamina = 2;
  });
});
