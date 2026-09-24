import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The webhook has no session — it's driven entirely by Telegram
 * updates, so requireTenantContext is NOT used/mocked here. Instead,
 * these tests prove tenant ownership is resolved only from data we
 * already persisted (TelegramChat/TelegramPoll -> groupId), and that
 * every path fails closed (never sends to Telegram, never writes)
 * when that trusted signal is missing.
 */

const mockChatFindUnique = vi.fn();
const mockChatUpsert = vi.fn();
const mockPollFindUnique = vi.fn();
const mockPollUpsert = vi.fn();
const mockPollUpdateMany = vi.fn();
const mockPlayerFindFirst = vi.fn();
const mockPlayerUpdate = vi.fn();
const mockAnswerUpsert = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramChat: {
      findUnique: (...args: unknown[]) => mockChatFindUnique(...args),
      upsert: (...args: unknown[]) => mockChatUpsert(...args),
    },
    telegramPoll: {
      findUnique: (...args: unknown[]) => mockPollFindUnique(...args),
      upsert: (...args: unknown[]) => mockPollUpsert(...args),
      updateMany: (...args: unknown[]) => mockPollUpdateMany(...args),
    },
    player: {
      findFirst: (...args: unknown[]) => mockPlayerFindFirst(...args),
      update: (...args: unknown[]) => mockPlayerUpdate(...args),
    },
    telegramPollAnswer: {
      upsert: (...args: unknown[]) => mockAnswerUpsert(...args),
    },
  },
}));

import { POST } from "./route";

const SECRET = "test-webhook-secret";
const originalFetch = global.fetch;

function webhookReq(update: unknown) {
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  global.fetch = vi.fn().mockRejectedValue(new Error("real Telegram API must never be called in tests"));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("webhook /poll command — chat-based group resolution", () => {
  it("an unregistered chat (no TelegramChat row) never triggers sendPoll and never writes a TelegramPoll", async () => {
    mockChatFindUnique.mockResolvedValue(null);

    const res = await POST(
      webhookReq({
        message: { text: "/poll", chat: { id: 555 }, from: { id: 1 } },
      })
    );
    expect(res.status).toBe(200);

    expect(mockChatFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: 555n } })
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
  });

  it("a registered chat with a null groupId (never backfilled) also fails closed — no default fallback group", async () => {
    mockChatFindUnique.mockResolvedValue({ groupId: null });

    await POST(webhookReq({ message: { text: "/poll", chat: { id: 555 }, from: { id: 1 } } }));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
  });

  it("a registered, owned chat resolves its groupId, calls sendPoll, and stamps that groupId on the poll upsert", async () => {
    mockChatFindUnique.mockResolvedValue({ groupId: "group-a" });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        ok: true,
        result: {
          message_id: 42,
          poll: { id: "poll-xyz", question: "Who is playing?", options: [], is_closed: false },
        },
      }),
    });
    mockPollUpsert.mockResolvedValue({ pollId: "poll-xyz" });

    await POST(webhookReq({ message: { text: "/poll", chat: { id: 555 }, from: { id: 1 } } }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const call = mockPollUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    expect(call.update.groupId).toBe("group-a");
  });
});

describe("webhook /link command — chat-based group resolution + player ownership", () => {
  it("an unregistered/unowned chat sends the generic failure message and never touches Player", async () => {
    mockChatFindUnique.mockResolvedValue(null);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    const res = await POST(
      webhookReq({
        message: { text: "/link player-1", chat: { id: 555 }, from: { id: 1, username: "bob" } },
      })
    );
    expect(res.status).toBe(200);

    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(mockPlayerUpdate).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sentText = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(sentText)).toContain("sendMessage");
  });

  it("a playerId belonging to a foreign group is rejected with the SAME generic message as a nonexistent playerId — no existence leak", async () => {
    mockChatFindUnique.mockResolvedValue({ groupId: "group-a" });
    mockPlayerFindFirst.mockResolvedValue(null); // simulates: player exists in group-b
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    await POST(
      webhookReq({
        message: { text: "/link player-in-group-b", chat: { id: 555 }, from: { id: 1, username: "bob" } },
      })
    );

    expect(mockPlayerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "player-in-group-b", groupId: "group-a" } })
    );
    expect(mockPlayerUpdate).not.toHaveBeenCalled();

    const lastCallBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].body
    );
    expect(lastCallBody.text).toBe("❌ Could not link. Check the playerId and try again.");
  });

  it("a same-group player is linked successfully, writing Player.telegramUserId", async () => {
    mockChatFindUnique.mockResolvedValue({ groupId: "group-a" });
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockPlayerUpdate.mockResolvedValue({ firstName: "A", lastName: "B" });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    await POST(
      webhookReq({
        message: { text: "/link p1", chat: { id: 555 }, from: { id: 999, username: "bob" } },
      })
    );

    expect(mockPlayerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ telegramUserId: 999n, telegramUsername: "bob" }),
      })
    );
  });
});

describe("webhook poll_answer — poll-based group resolution", () => {
  it("an unknown/unowned pollId fails closed: the answer upsert is never called", async () => {
    mockPollFindUnique.mockResolvedValue(null);

    const res = await POST(
      webhookReq({
        poll_answer: { poll_id: "unknown-poll", user: { id: 1 }, option_ids: [0] },
      })
    );
    expect(res.status).toBe(200);
    expect(mockAnswerUpsert).not.toHaveBeenCalled();
  });

  it("a poll with a null groupId also fails closed — no default fallback group", async () => {
    mockPollFindUnique.mockResolvedValue({ groupId: null });

    await POST(
      webhookReq({ poll_answer: { poll_id: "poll-1", user: { id: 1 }, option_ids: [0] } })
    );
    expect(mockAnswerUpsert).not.toHaveBeenCalled();
  });

  it("a resolvable poll stamps its groupId on both the create and update branches of the answer upsert", async () => {
    mockPollFindUnique.mockResolvedValue({ groupId: "group-a" });
    mockAnswerUpsert.mockResolvedValue({});

    await POST(
      webhookReq({
        poll_answer: { poll_id: "poll-1", user: { id: 42, username: "bob" }, option_ids: [0] },
      })
    );

    expect(mockPollFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: "poll-1" } })
    );
    const call = mockAnswerUpsert.mock.calls[0][0];
    expect(call.create.groupId).toBe("group-a");
    expect(call.update.groupId).toBe("group-a");
    expect(call.where).toEqual({ pollId_userId: { pollId: "poll-1", userId: 42n } });
  });
});

describe("webhook /chatid command — diagnostic only, never mutates TelegramChat (Phase 2D.3a)", () => {
  it("an unknown chat: replies with the chat id, but never creates/upserts a TelegramChat row", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    const res = await POST(
      webhookReq({
        message: { text: "/chatid", chat: { id: 777, title: "New Group" }, from: { id: 1 } },
      })
    );
    expect(res.status).toBe(200);

    expect(mockChatUpsert).not.toHaveBeenCalled();
    expect(mockChatFindUnique).not.toHaveBeenCalled();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain("777");
    expect(body.text).not.toMatch(/registered/i);
  });

  it("an already-registered chat: /chatid still replies, but does not read or modify the existing row", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    await POST(
      webhookReq({
        message: { text: "/chatid", chat: { id: 555, title: "Indoor Soccer" }, from: { id: 1 } },
      })
    );

    expect(mockChatUpsert).not.toHaveBeenCalled();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
  });

  it("no Group lookup or default-Group fallback occurs anywhere in the /chatid path", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    await POST(
      webhookReq({
        message: { text: "/chatid", chat: { id: 888 }, from: { id: 1 } },
      })
    );

    // No prisma call of any kind is made for /chatid — proven by every
    // mocked model method across this file remaining untouched.
    expect(mockChatUpsert).not.toHaveBeenCalled();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    expect(mockPollFindUnique).not.toHaveBeenCalled();
    expect(mockPollUpsert).not.toHaveBeenCalled();
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(mockPlayerUpdate).not.toHaveBeenCalled();
    expect(mockAnswerUpsert).not.toHaveBeenCalled();
  });
});

describe("webhook auth", () => {
  it("rejects a request with a missing/wrong secret before touching any handler", async () => {
    const res = await POST(
      new Request("http://localhost/api/telegram/webhook", {
        method: "POST",
        body: JSON.stringify({ poll_answer: { poll_id: "poll-1", user: { id: 1 }, option_ids: [0] } }),
      }) as unknown as Parameters<typeof POST>[0]
    );
    expect(res.status).toBe(401);
    expect(mockPollFindUnique).not.toHaveBeenCalled();
  });
});
