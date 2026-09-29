import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockChatFindFirst = vi.fn();
const mockPollUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramChat: { findFirst: (...args: unknown[]) => mockChatFindFirst(...args) },
    telegramPoll: { upsert: (...args: unknown[]) => mockPollUpsert(...args) },
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

const GROUP_B = { id: "group-b", name: "B", slug: "group-b", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_B = {
  user: { id: "u2", email: "b@example.com", name: null },
  organization: { id: "org-b", name: "Org B", slug: "org-b" },
  membership: { id: "m2", role: "OWNER" as const },
  groups: [GROUP_B],
  activeGroup: GROUP_B,
};

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function req(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  // NEVER let a test reach the real Telegram API.
  global.fetch = vi.fn().mockRejectedValue(new Error("real Telegram API must never be called in tests"));
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockSuccessfulSendPoll() {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    json: async () => ({ ok: true, result: { message_id: 42, poll: { id: "poll-xyz" } } }),
  });
}

describe("POST canonical telegram/create-poll — ordering + isolation", () => {
  it("resolves tenant via the URL slugs", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({});

    await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("chat lookup uses the URL-resolved active groupId", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({});

    await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));

    expect(mockChatFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: 111n, groupId: "group-a" } })
    );
  });

  it("a foreign-Group chatId is rejected with 404 BEFORE any Telegram call", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue(null); // simulates: chatId belongs to group-b

    const res = await POST(req({ chatId: "999", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
  });

  it("an unregistered (unknown) chatId is rejected before any Telegram call", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue(null);

    const res = await POST(req({ chatId: "424242", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a valid same-Group chatId proceeds, calls Telegram exactly once, and stamps TelegramPoll with the active groupId", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({ pollId: "poll-xyz" });

    const res = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const call = mockPollUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    expect(call.update.groupId).toBe("group-a");
  });

  it("a body groupId cannot influence the ownership check or the stamped groupId", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({});

    await POST(req({ chatId: "111", pollDate: "2026-09-28", groupId: "group-b" }), ctx("org-a", "group-a"));

    expect(mockChatFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
    expect(mockPollUpsert.mock.calls[0][0].create.groupId).toBe("group-a");
  });

  it("a body organizationId cannot influence tenant resolution", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({});

    await POST(req({ chatId: "111", pollDate: "2026-09-28", organizationId: "org-b" }), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("the same chatId cannot cross Organizations/Groups — Group A and Group B each resolve independently", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    mockSuccessfulSendPoll();
    mockPollUpsert.mockResolvedValue({});
    await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));
    const callA = mockChatFindFirst.mock.calls[0][0];

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockChatFindFirst.mockResolvedValue(null);
    const res = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-b", "group-b"));

    expect(callA.where.groupId).toBe("group-a");
    expect(mockChatFindFirst.mock.calls[1][0].where.groupId).toBe("group-b");
    expect(res.status).toBe(404);
  });

  it("invalid tenant fails closed before any Telegram call or DB mutation", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockChatFindFirst).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
  });

  it("unknown Organization fails closed identically to a foreign Group (no existence leak)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("propagates UNAUTHENTICATED as 401 without touching TelegramChat or Telegram", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(req({ chatId: "111", pollDate: "2026-09-28" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockChatFindFirst).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("request validation runs safely and rejects a malformed body before any DB/Telegram access", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    const res = await POST(req({ chatId: "", pollDate: "not-a-date" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(400);
    expect(mockChatFindFirst).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
