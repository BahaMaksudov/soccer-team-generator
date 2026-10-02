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

const mockRedeem = vi.fn();
vi.mock("@/lib/telegramConnect", () => ({ redeemTelegramConnectCode: (...args: unknown[]) => mockRedeem(...args) }));

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

describe("webhook /poll command — retired in M9-A (creates nothing)", () => {
  const okFetch = () => (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

  for (const [label, chat] of [
    ["an unregistered chat", null],
    ["a registered chat of a Group", { groupId: "group-a" }],
  ] as const) {
    it(`${label}: no poll, no Match, no attendance — only a guidance reply`, async () => {
      mockChatFindUnique.mockResolvedValue(chat);
      okFetch();
      const res = await POST(webhookReq({ message: { text: "/poll", chat: { id: 555 }, from: { id: 1 } } }));
      expect(res.status).toBe(200);
      expect(mockPollUpsert).not.toHaveBeenCalled();
      expect(mockChatFindUnique).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toMatch(/\/sendMessage$/);
      expect(JSON.parse(init.body).text).toBe("Create attendance polls from Team Balance Pro.");
    });
  }
});

describe("webhook /link command — retired in M6-C (never writes anything)", () => {
  it.each(["/link p1", "/link player-in-group-b", "/link"])("%s only replies with guidance; no Player/chat lookup or write", async (text) => {
    mockChatFindUnique.mockResolvedValue({ groupId: "group-a" });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });

    const res = await POST(webhookReq({ message: { text, chat: { id: 555 }, from: { id: 999, username: "bob" } } }));
    expect(res.status).toBe(200);
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
    expect(mockPlayerUpdate).not.toHaveBeenCalled();
    expect(mockChatFindUnique).not.toHaveBeenCalled();
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].body);
    expect(body.text).toContain("no longer supported");
  });
});

describe("webhook /connect and /start CODE (M6-C)", () => {
  const reply = () => JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].body).text as string;
  beforeEach(() => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });
  });

  it("redeems the code for the SENDER's Telegram id and confirms", async () => {
    mockRedeem.mockResolvedValue({ ok: true, playerName: "Doni Alpha", groupName: "Indoor Soccer", alreadyLinked: false });
    await POST(webhookReq({ message: { text: "/connect AbCdEfGhIjKlMnOpQrStUv", chat: { id: 4242 }, from: { id: 4242 } } }));
    expect(mockRedeem).toHaveBeenCalledWith({ code: "AbCdEfGhIjKlMnOpQrStUv", telegramUserId: 4242n });
    expect(reply()).toBe("✅ Connected your Telegram account to Doni Alpha (Indoor Soccer).");
  });

  it("/start CODE (t.me deep link) is the same; bare /start does nothing", async () => {
    mockRedeem.mockResolvedValue({ ok: false, code: "INVALID" });
    await POST(webhookReq({ message: { text: "/start AbCdEfGhIjKlMnOpQrStUv", chat: { id: 1 }, from: { id: 1 } } }));
    expect(mockRedeem).toHaveBeenCalledTimes(1);
    expect(reply()).toContain("invalid or has expired");
    vi.clearAllMocks();
    await POST(webhookReq({ message: { text: "/start", chat: { id: 1 }, from: { id: 1 } } }));
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it("an identity already linked to another Player in that Group gets a safe message", async () => {
    mockRedeem.mockResolvedValue({ ok: false, code: "TELEGRAM_LINKED_TO_OTHER_PLAYER" });
    await POST(webhookReq({ message: { text: "/connect AbCdEfGhIjKlMnOpQrStUv", chat: { id: 1 }, from: { id: 1 } } }));
    expect(reply()).toContain("already linked to another player");
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

describe("webhook /chatid command — retired in M9-A (no chat id is revealed)", () => {
  it("replies with connection guidance, never the chat id, and touches no data", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ json: async () => ({ ok: true, result: {} }) });
    const res = await POST(webhookReq({ message: { text: "/chatid", chat: { id: 777, title: "New Group" }, from: { id: 1 } } }));
    expect(res.status).toBe(200);
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).not.toContain("777");
    expect(body.text).toContain("Communication Channels");
    for (const m of [mockChatUpsert, mockChatFindUnique, mockPollFindUnique, mockPollUpsert, mockPlayerFindFirst, mockPlayerUpdate, mockAnswerUpsert]) {
      expect(m).not.toHaveBeenCalled();
    }
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
