import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

// In-memory TelegramUserLink table (M6-C: unique (groupId, userId) and unique playerId).
type Link = { id: string; userId: bigint; playerId: string; groupId: string };
let links: Link[];
const mockPlayerFindFirst = vi.fn();
const tx = {
  telegramUserLink: {
    findUnique: vi.fn(async ({ where }: { where: { groupId_userId?: { groupId: string; userId: bigint }; playerId?: string } }) => {
      if (where.groupId_userId) {
        const { groupId, userId } = where.groupId_userId;
        return links.find((l) => l.groupId === groupId && l.userId === userId) ?? null;
      }
      return links.find((l) => l.playerId === where.playerId) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<Link, "id"> }) => {
      const row = { id: `l${links.length + 1}`, ...data };
      links.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Link> }) => {
      const row = links.find((l) => l.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
  },
};
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findFirst: (...args: unknown[]) => mockPlayerFindFirst(...args) },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
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
const ctx = (organizationSlug: string, groupSlug: string) => ({ params: Promise.resolve({ organizationSlug, groupSlug }) });
const req = (body: unknown) => new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  links = [];
  fetchSpy = vi.spyOn(global, "fetch");
  mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
  mockPlayerFindFirst.mockImplementation(async ({ where }: { where: { id: string; groupId: string } }) =>
    where.groupId === "group-a" && ["p1", "p2"].includes(where.id) ? { id: where.id, firstName: "A", lastName: "B" } : null
  );
});

describe("POST canonical telegram/link — Group-scoped identity (M6-C)", () => {
  it("links a Telegram user to an active-Group Player, stamped with the URL-resolved Group", async () => {
    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(links).toEqual([{ id: "l1", userId: 555n, playerId: "p1", groupId: "group-a" }]);
    expect(tx.telegramUserLink.findUnique.mock.calls[0][0].where).toEqual({ groupId_userId: { groupId: "group-a", userId: 555n } });
  });

  it("the same Telegram user linked in ANOTHER Group is not a conflict and that link is never touched", async () => {
    links = [{ id: "lb", userId: 555n, playerId: "pb1", groupId: "group-b" }];
    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(links).toEqual([
      { id: "lb", userId: 555n, playerId: "pb1", groupId: "group-b" },
      { id: "l2", userId: 555n, playerId: "p1", groupId: "group-a" },
    ]);
  });

  it("re-linking within the SAME Group moves the identity to the chosen Player (never two links in one Group)", async () => {
    links = [{ id: "la", userId: 555n, playerId: "p1", groupId: "group-a" }];
    const res = await POST(req({ userId: "555", playerId: "p2" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(links).toEqual([{ id: "la", userId: 555n, playerId: "p2", groupId: "group-a" }]);
  });

  it("linking the same pair again is a no-op", async () => {
    links = [{ id: "la", userId: 555n, playerId: "p1", groupId: "group-a" }];
    expect((await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"))).status).toBe(200);
    expect(tx.telegramUserLink.create).not.toHaveBeenCalled();
    expect(tx.telegramUserLink.update).not.toHaveBeenCalled();
  });

  it("a Player already linked to a DIFFERENT Telegram account gets a clear 409 and nothing changes", async () => {
    links = [{ id: "la", userId: 777n, playerId: "p1", groupId: "group-a" }];
    const res = await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This player is already linked to a different Telegram account." });
    expect(links).toEqual([{ id: "la", userId: 777n, playerId: "p1", groupId: "group-a" }]);
  });

  it("a foreign-Group Player is rejected with 404 before any mutation — player lookup scoped by groupId", async () => {
    const res = await POST(req({ userId: "555", playerId: "player-in-group-b" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "player-in-group-b", groupId: "group-a" } }));
    expect(links).toEqual([]);
  });

  it("a body groupId/organizationId cannot switch tenancy", async () => {
    await POST(req({ userId: "555", playerId: "p1", groupId: "group-b", organizationId: "org-b" }), ctx("org-a", "group-a"));
    expect(mockPlayerFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
    expect(links[0].groupId).toBe("group-a");
  });

  it("invalid tenant fails closed (404) and unauthenticated is 401 — before any lookup or mutation", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValueOnce(new TenantContextError("NO_GROUP"));
    expect((await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "x"))).status).toBe(404);
    mockRequireTenantContextForSlugs.mockRejectedValueOnce(new TenantContextError("UNAUTHENTICATED"));
    expect((await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"))).status).toBe(401);
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(links).toEqual([]);
  });

  it("M6.1: ADMIN may link; MEMBER is refused with the generic 404 before any lookup or mutation", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValueOnce({ ...CONTEXT_A, membership: { id: "m2", role: "ADMIN" } });
    expect((await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"))).status).toBe(200);
    links = [{ id: "la", userId: 555n, playerId: "p1", groupId: "group-a" }];
    vi.clearAllMocks();
    mockRequireTenantContextForSlugs.mockResolvedValueOnce({ ...CONTEXT_A, membership: { id: "m3", role: "MEMBER" } });
    const res = await POST(req({ userId: "555", playerId: "p2" }), ctx("org-a", "group-a")); // a move attempt
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(tx.telegramUserLink.findUnique).not.toHaveBeenCalled();
    expect(links).toEqual([{ id: "la", userId: 555n, playerId: "p1", groupId: "group-a" }]);
  });

  it("never calls the Telegram Bot API (no fetch)", async () => {
    await POST(req({ userId: "555", playerId: "p1" }), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
