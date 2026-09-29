import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";

const originalFetch = global.fetch;

function respond(json: () => Promise<unknown>) {
  global.fetch = vi.fn().mockResolvedValue({ json }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("callTelegram error classification", () => {
  it("returns result on ok:true", async () => {
    respond(async () => ({ ok: true, result: { message_id: 1 } }));
    await expect(callTelegram("sendMessage", {})).resolves.toEqual({ message_id: 1 });
  });

  it("parsed ok:false → TelegramApiRejectionError carrying description and code", async () => {
    respond(async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    const err = await callTelegram("sendMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiRejectionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Bad Request: chat not found");
    expect(err.errorCode).toBe(400);
    expect(err.method).toBe("sendMessage");
  });

  it("unparseable body → plain (ambiguous) Error, not a rejection", async () => {
    respond(async () => {
      throw new SyntaxError("bad json");
    });
    const err = await callTelegram("sendMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TelegramApiRejectionError);
  });

  it("response without an ok field → ambiguous, not a rejection", async () => {
    respond(async () => ({ something: "else" }));
    const err = await callTelegram("sendMessage", {}).catch((e) => e);
    expect(err).not.toBeInstanceOf(TelegramApiRejectionError);
  });

  it("network failure → ambiguous, not a rejection", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    const err = await callTelegram("sendMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(TelegramApiRejectionError);
  });

  it("missing token throws before any fetch", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    global.fetch = vi.fn() as unknown as typeof fetch;
    await expect(callTelegram("sendMessage", {})).rejects.toThrow("Missing TELEGRAM_BOT_TOKEN");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
