import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockPlayerFindFirst = vi.fn();
const mockLinkFindUnique = vi.fn();
const mockLinkUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findFirst: (...args: unknown[]) => mockPlayerFindFirst(...args) },
    telegramUserLink: {
      findUnique: (...args: unknown[]) => mockLinkFindUnique(...args),
      upsert: (...args: unknown[]) => mockLinkUpsert(...args),
    },
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
  fetchSpy = vi.spyOn(global, "fetch");
});

describe("POST canonical telegram/link — isolation", () => {
  it("successfully links to an active-Group Player", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({ userId: 555n, playerId: "p1", groupId: "group-a" });

    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    const call = mockLinkUpsert.mock.calls[0][0];
    expect(call.create).toEqual({ userId: 555n, playerId: "p1", groupId: "group-a" });
  });

  it("a foreign-Group Player is rejected with 404 BEFORE any mutation — player lookup scoped by groupId", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue(null); // simulates: playerId exists but belongs to group-b

    const res = await POST(req({ userId: "555", playerId: "player-in-group-b" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(404);

    expect(mockPlayerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "player-in-group-b", groupId: "group-a" } })
    );
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("TelegramUserLink rows are stamped with the URL-resolved active groupId", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({});

    await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));

    const call = mockLinkUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    expect(call.update.groupId).toBe("group-a");
  });

  it("re-linking within the SAME Group is allowed, not rejected", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p2", firstName: "C", lastName: "D" });
    mockLinkFindUnique.mockResolvedValue({ userId: 555n, playerId: "p1", groupId: "group-a" });
    mockLinkUpsert.mockResolvedValue({});

    const res = await POST(req({ userId: "555", playerId: "p2" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(mockLinkUpsert).toHaveBeenCalled();
  });

  it("a Telegram identity already linked under a DIFFERENT Group returns the existing safe 409 and does not mutate", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue({ userId: 555n, playerId: "p-old", groupId: "group-b" });

    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(409);
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("the foreign-Group refusal is generic: no Group/player/org metadata and no 'linked elsewhere' disclosure (Phase 2D.6E.6C)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue({ userId: 555n, playerId: "p-other-group", groupId: "group-b" });

    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "This Telegram user cannot be linked." }));
    expect(text).not.toMatch(/elsewhere|group-b|p-other-group|org-|Group B/i);
    // No reassignment: the existing foreign link is never touched.
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("a body groupId/organizationId cannot switch tenancy", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({});

    await POST(
      req({ userId: "555", playerId: "p1", groupId: "group-b", organizationId: "org-b" }),
      ctx("org-a", "group-a")
    );

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockPlayerFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
    expect(mockLinkUpsert.mock.calls[0][0].create.groupId).toBe("group-a");
  });

  it("invalid tenant fails closed before any mutation", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("global TelegramUserLink.userId uniqueness behavior is unchanged — where clause is userId only, no groupId compound key", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({});

    await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));

    expect(mockLinkFindUnique).toHaveBeenCalledWith({ where: { userId: 555n } });
    expect(mockLinkUpsert.mock.calls[0][0].where).toEqual({ userId: 555n });
  });

  it("propagates UNAUTHENTICATED as 401 without touching Player or TelegramUserLink", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
  });
});

describe("POST canonical telegram/link — side-effect prohibition", () => {
  it("never calls the Telegram Bot API (no fetch)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({});

    await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
