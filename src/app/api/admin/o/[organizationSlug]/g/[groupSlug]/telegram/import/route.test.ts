import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockPollFindFirst = vi.fn();
const mockAnswerFindMany = vi.fn();
const mockLinkFindMany = vi.fn();
const mockPlayerFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPoll: { findFirst: (...args: unknown[]) => mockPollFindFirst(...args) },
    telegramPollAnswer: { findMany: (...args: unknown[]) => mockAnswerFindMany(...args) },
    telegramUserLink: { findMany: (...args: unknown[]) => mockLinkFindMany(...args) },
    player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) },
  },
}));

import { POST } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function req(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPlayerFindMany.mockResolvedValue([]);
  fetchSpy = vi.spyOn(global, "fetch");
});

describe("POST canonical telegram/import — isolation", () => {
  it("successful canonical import returns selectedPlayerIds for the URL-resolved Group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([{ userId: 1n, optionIdsJson: JSON.stringify([0]) }]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p1" }]);
    mockPlayerFindMany.mockResolvedValue([{ id: "p1" }]);

    const res = await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.selectedPlayerIds).toEqual(["p1"]);
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("poll lookup is scoped to the URL-resolved active Group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([]);

    await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));

    expect(mockPollFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: "poll-1", groupId: "group-a", kind: "ATTENDANCE" } })
    );
  });

  it("a foreign-Group poll is rejected with a generic 404, never exposing existence", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue(null); // simulates: pollId exists but belongs to group-b

    const res = await POST(req({ pollId: "poll-in-group-b" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(404);
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
  });

  it("answers are queried with an explicit groupId filter", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([]);

    await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));

    expect(mockAnswerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: "poll-1", groupId: "group-a" } })
    );
  });

  it("links are queried with an explicit groupId filter", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([{ userId: 1n, optionIdsJson: JSON.stringify([0]) }]);
    mockLinkFindMany.mockResolvedValue([]);

    await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));

    expect(mockLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: [1n] }, groupId: "group-a" } })
    );
  });

  it("returned players are re-verified to belong to the active Group (defense in depth)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([{ userId: 1n, optionIdsJson: JSON.stringify([0]) }]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p-stale" }]);
    mockPlayerFindMany.mockResolvedValue([]); // Player.findMany scoped by activeGroupId finds nothing

    const res = await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));
    const data = await res.json();

    expect(data.selectedPlayerIds).toEqual([]);
    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p-stale"] }, groupId: "group-a" } })
    );
  });

  it("a body groupId/organizationId cannot influence tenancy", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([]);

    await POST(req({ pollId: "poll-1", groupId: "group-b", organizationId: "org-b" }), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockPollFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
  });

  it("invalid tenant fails closed before any Prisma tenant-owned query", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(req({ pollId: "poll-1" }), ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockPollFindFirst).not.toHaveBeenCalled();
  });

  it("unknown Organization and foreign Group produce the identical status + body", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await POST(req({ pollId: "poll-1" }), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("propagates UNAUTHENTICATED as 401 without touching TelegramPoll", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockPollFindFirst).not.toHaveBeenCalled();
  });
});

describe("POST canonical telegram/import — side-effect prohibition", () => {
  it("never calls the Telegram Bot API (no fetch)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([{ userId: 1n, optionIdsJson: JSON.stringify([0]) }]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p1" }]);
    mockPlayerFindMany.mockResolvedValue([{ id: "p1" }]);

    await POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never mutates any Telegram/Player table", async () => {
    // No create/update/upsert/delete mock is even registered on the
    // mocked prisma models above — if the implementation ever called
    // one, the call would throw (undefined method) and this test's
    // POST call would reject.
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([{ userId: 1n, optionIdsJson: JSON.stringify([0]) }]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p1" }]);
    mockPlayerFindMany.mockResolvedValue([{ id: "p1" }]);

    await expect(POST(req({ pollId: "poll-1" }), ctx("org-a", "group-a"))).resolves.toBeDefined();
  });
});
