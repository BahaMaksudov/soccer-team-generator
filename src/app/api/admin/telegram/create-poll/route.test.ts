import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
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

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function createPollReq(body: unknown) {
  return new Request("http://localhost/api/admin/telegram/create-poll", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  // NEVER let a test reach the real Telegram API. Any call that gets
  // this far without being rejected first is a test failure waiting
  // to happen, not a real network call.
  global.fetch = vi.fn().mockRejectedValue(new Error("real Telegram API must never be called in tests"));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("POST /api/admin/telegram/create-poll", () => {
  it("a chatId belonging to another group is rejected with 404 BEFORE any Telegram API call", async () => {
    mockChatFindFirst.mockResolvedValue(null); // simulates: chatId exists, but belongs to group-b

    const res = await POST(createPollReq({ chatId: "999", pollDate: "2026-09-28" }));
    expect(res.status).toBe(404);

    expect(mockChatFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: 999n, groupId: "group-a" } })
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
  });

  it("an unregistered chatId (no TelegramChat row at all) is also rejected before any Telegram call", async () => {
    mockChatFindFirst.mockResolvedValue(null);

    const res = await POST(createPollReq({ chatId: "424242", pollDate: "2026-09-28" }));
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a valid same-group chatId proceeds, calls Telegram, and stamps groupId on both create/update", async () => {
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        ok: true,
        result: { message_id: 42, poll: { id: "poll-xyz" } },
      }),
    });
    mockPollUpsert.mockResolvedValue({ pollId: "poll-xyz" });

    const res = await POST(createPollReq({ chatId: "111", pollDate: "2026-09-28" }));
    expect(res.status).toBe(200);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const call = mockPollUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    expect(call.update.groupId).toBe("group-a");
  });

  it("a client-supplied groupId in the body cannot influence the stamped groupId (schema has no such field, and it is never read from body)", async () => {
    mockChatFindFirst.mockResolvedValue({ chatId: 111n });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        ok: true,
        result: { message_id: 42, poll: { id: "poll-xyz" } },
      }),
    });
    mockPollUpsert.mockResolvedValue({ pollId: "poll-xyz" });

    await POST(createPollReq({ chatId: "111", pollDate: "2026-09-28", groupId: "group-b" }));

    const call = mockPollUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    // The ownership check itself also used group-a, not the attacker's group-b:
    expect(mockChatFindFirst.mock.calls[0][0].where.groupId).toBe("group-a");
  });

  it("propagates UNAUTHENTICATED without ever touching TelegramChat or calling Telegram", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(createPollReq({ chatId: "111", pollDate: "2026-09-28" }));
    expect(res.status).toBe(401);
    expect(mockChatFindFirst).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
