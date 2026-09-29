import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
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
    // Phase 2D.6D.5C — added for the new defense-in-depth Player
    // verification in importTelegramPollForContext (see
    // src/lib/telegramAdmin.ts). Not exercised by any existing
    // assertion; only stubbed so tests that reach this code path don't
    // throw on an undefined prisma.player.
    player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) },
  },
}));

import { POST } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function importReq(body: unknown) {
  return new Request("http://localhost/api/admin/telegram/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
  mockPlayerFindMany.mockResolvedValue([]);
});

describe("POST /api/admin/telegram/import", () => {
  it("a poll belonging to another group is rejected with 404 — poll lookup itself is scoped by groupId", async () => {
    mockPollFindFirst.mockResolvedValue(null); // simulates: pollId exists, but belongs to group-b

    const res = await POST(importReq({ pollId: "poll-in-group-b" }));
    expect(res.status).toBe(404);

    expect(mockPollFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: "poll-in-group-b", groupId: "group-a" } })
    );
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
  });

  it("answers and links are queried with an explicit groupId filter — defense in depth, not just the poll check", async () => {
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([
      { userId: 1n, optionIdsJson: JSON.stringify([0]) },
    ]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p1" }]);
    mockPlayerFindMany.mockResolvedValue([{ id: "p1" }]);

    const res = await POST(importReq({ pollId: "poll-1" }));
    expect(res.status).toBe(200);

    expect(mockAnswerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: "poll-1", groupId: "group-a" } })
    );
    expect(mockLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: [1n] }, groupId: "group-a" },
      })
    );

    const data = await res.json();
    expect(data.selectedPlayerIds).toEqual(["p1"]);
  });

  it("a mixed answer pool never leaks a foreign-group voter's identity into missingUserIds/selectedPlayerIds beyond what the scoped query itself returns", async () => {
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    // The mocked DB only returns rows matching (pollId, groupId) —
    // simulating that a group-b answer for the same pollId (if it
    // somehow existed) is invisible to this query by construction.
    mockAnswerFindMany.mockResolvedValue([
      { userId: 1n, optionIdsJson: JSON.stringify([0]) },
    ]);
    mockLinkFindMany.mockResolvedValue([]);

    const res = await POST(importReq({ pollId: "poll-1" }));
    const data = await res.json();
    expect(data.selectedPlayerIds).toEqual([]);
    expect(data.missingUserIds).toEqual(["1"]);
  });

  it("Phase 2D.6D.5C defense-in-depth: a selectedPlayerId whose Player row is not in the active Group is filtered out even if the (denormalized) link claimed it", async () => {
    mockPollFindFirst.mockResolvedValue({ pollId: "poll-1" });
    mockAnswerFindMany.mockResolvedValue([
      { userId: 1n, optionIdsJson: JSON.stringify([0]) },
    ]);
    mockLinkFindMany.mockResolvedValue([{ userId: 1n, playerId: "p-stale" }]);
    // Simulates a corrupted/stale denormalized groupId on the link: the
    // Player lookup (scoped to the active Group) finds nothing for
    // "p-stale".
    mockPlayerFindMany.mockResolvedValue([]);

    const res = await POST(importReq({ pollId: "poll-1" }));
    const data = await res.json();

    expect(data.selectedPlayerIds).toEqual([]);
    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p-stale"] }, groupId: "group-a" } })
    );
  });

  it("propagates UNAUTHENTICATED without ever touching TelegramPoll", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(importReq({ pollId: "poll-1" }));
    expect(res.status).toBe(401);
    expect(mockPollFindFirst).not.toHaveBeenCalled();
  });
});
