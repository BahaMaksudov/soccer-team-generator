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
vi.mock("@/lib/prisma", () => ({
  prisma: {
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

const SAMPLE_TEAMS = [{ teamNumber: 1, players: [{ firstName: "A", lastName: "B" }] }];

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function publishReq(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
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

    await POST(publishReq({ date: "2026-09-28", teams: [{ teamNumber: 1, players: [{ firstName: "C", lastName: "D" }] }] }), ctx("org-a", "group-a"));
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

    expect(data.pollStatus).toBe("not_requested");
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
