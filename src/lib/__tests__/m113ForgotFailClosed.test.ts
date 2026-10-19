import { describe, it, expect, vi, beforeEach } from "vitest";

/** M11.3 — "Forgot password" fails CLOSED when its database rate limit is unavailable (Upstash missing too). */
const scheduled: Array<() => unknown> = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void scheduled.push(fn) }));
const limit = vi.fn();
vi.mock("@/lib/passwordResetLimit", () => ({ checkPasswordResetLimit: (...a: unknown[]) => limit(...a) }));
const prepare = vi.fn();
vi.mock("@/lib/passwordReset", async (orig) => ({ ...(await orig<typeof import("@/lib/passwordReset")>()), preparePasswordReset: (...a: unknown[]) => prepare(...a) }));

import { POST } from "@/app/api/password/forgot/route";

const req = (email = "a@example.test") => new Request("http://t.local/", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: JSON.stringify({ email }) });

describe("forgot password without Upstash", () => {
  beforeEach(() => {
    scheduled.length = 0;
    limit.mockReset();
    prepare.mockReset();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("VERCEL", "1"); // M12-A — forwarding headers are trusted only behind Vercel's proxy
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("database limit unavailable → 503, nothing scheduled, no account lookup", async () => {
    limit.mockRejectedValue(new Error("db down"));
    const r = await POST(req());
    expect(r.status).toBe(503);
    expect(scheduled).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("per-address limit → 429; per-email / service-wide limit → the generic 200 and nothing scheduled", async () => {
    limit.mockResolvedValue("ip_limited");
    expect((await POST(req())).status).toBe(429);
    for (const d of ["email_limited", "global_limited"]) {
      limit.mockResolvedValue(d);
      const r = await POST(req());
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);
    }
    expect(scheduled).toEqual([]);
    limit.mockResolvedValue("send");
    await POST(req("A@Example.test "));
    expect(limit).toHaveBeenLastCalledWith("a@example.test", "203.0.113.5");
    expect(scheduled).toHaveLength(1);
  });
});
