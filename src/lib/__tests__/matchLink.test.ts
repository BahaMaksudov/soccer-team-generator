import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * M9.3 — Match Link primitives: the HMAC token (dedicated MATCH_SHARE_SECRET),
 * opaque player references, display names, same-origin, robots/noindex and the
 * anonymous endpoints' guards (rate limit stubbed — no Upstash, no database).
 */
const rateLimited = { read: false, write: false };
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: async (bucket: string) => ({ allowed: !(bucket === "match-link-read" ? rateLimited.read : rateLimited.write) }),
  clientKey: () => "test",
}));
const answerThroughMatchLink = vi.fn();
const matchLinkView = vi.fn();
vi.mock("@/lib/matchLink", () => ({
  answerThroughMatchLink: (...a: unknown[]) => answerThroughMatchLink(...a),
  matchLinkView: (...a: unknown[]) => matchLinkView(...a),
  matchLinkResponse: vi.fn(async () => null),
}));
vi.mock("@/lib/matchPage", () => ({ resolveShareMatchView: vi.fn(async () => null) }));

import { isWellFormedPlayerRef, matchLinkPath, matchPlayerRef, matchShareConfigured, matchShareToken, resolvePlayerRef, verifyMatchShareToken } from "@/lib/matchShare";
import { isSameOrigin } from "@/lib/sameOrigin";
import robots, { PRIVATE_PREFIXES } from "@/app/robots";
import * as answerRoute from "@/app/api/share/match/attendance/route";
import * as viewRoute from "@/app/api/share/match/route";

const ENV = { MATCH_SHARE_SECRET: "a-dedicated-match-share-secret-for-tests-0123" };
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

describe("Match Link token", () => {
  it("is deterministic per (match, version), 256-bit base64url, and differs by Match and after a reset", () => {
    const t = matchShareToken("m1", 1, ENV)!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(matchShareToken("m1", 1, ENV)).toBe(t);
    expect(matchShareToken("m2", 1, ENV)).not.toBe(t);
    expect(matchShareToken("m1", 2, ENV)).not.toBe(t);
    // Field boundaries are unambiguous ("m1"+"12" ≠ "m11"+"2").
    expect(matchShareToken("m1", 12, ENV)).not.toBe(matchShareToken("m11", 2, ENV));
  });

  it("verifies only the current token of the same Match", () => {
    const t = matchShareToken("m1", 3, ENV)!;
    expect(verifyMatchShareToken("m1", 3, t, ENV)).toBe(true);
    expect(verifyMatchShareToken("m1", 4, t, ENV)).toBe(false); // reset → stale
    expect(verifyMatchShareToken("m2", 3, t, ENV)).toBe(false); // Match A's token for Match B
    const flipped = (t[0] === "A" ? "B" : "A") + t.slice(1);
    expect(verifyMatchShareToken("m1", 3, flipped, ENV)).toBe(false);
    for (const bad of [null, undefined, 42, "", "short", t + "x", t.slice(1), "!".repeat(43)]) expect(verifyMatchShareToken("m1", 3, bad, ENV)).toBe(false);
  });

  it("uses a constant-time comparison and a dedicated, domain-separated secret (never NEXTAUTH_SECRET)", () => {
    const src = read("src/lib/matchShare.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // code only
    expect(src).toContain("timingSafeEqual(given, expected)");
    expect(src).toContain('"tbp:match-link:v1"');
    expect(src).not.toMatch(/NEXTAUTH_SECRET|console\./);
    const other = { MATCH_SHARE_SECRET: "another-dedicated-secret-of-enough-length-xyz" };
    expect(matchShareToken("m1", 1, other)).not.toBe(matchShareToken("m1", 1, ENV));
  });

  it("fails safely without a strong MATCH_SHARE_SECRET: nothing issued, nothing accepted, no fallback", () => {
    const t = matchShareToken("m1", 1, ENV)!;
    for (const env of [{}, { MATCH_SHARE_SECRET: "" }, { MATCH_SHARE_SECRET: "x".repeat(31) }, { NEXTAUTH_SECRET: ENV.MATCH_SHARE_SECRET }]) {
      expect(matchShareConfigured(env)).toBe(false);
      expect(matchShareToken("m1", 1, env)).toBeNull();
      expect(verifyMatchShareToken("m1", 1, t, env)).toBe(false);
      expect(matchPlayerRef("m1", 1, "p1", env)).toBeNull();
    }
  });

  it("the link keeps the token in the URL fragment", () => {
    expect(matchLinkPath("m 1", "tok")).toBe("/share/m/m%201#tok");
  });
});

describe("opaque player references", () => {
  it("are link-bound: resolve among the roster only, never across Matches or after a reset", () => {
    const ref = matchPlayerRef("m1", 1, "p2", ENV)!;
    expect(isWellFormedPlayerRef(ref)).toBe(true);
    expect(ref).not.toContain("p2");
    expect(resolvePlayerRef("m1", 1, ref, ["p1", "p2", "p3"], ENV)).toBe("p2");
    expect(resolvePlayerRef("m1", 1, ref, ["p1", "p3"], ENV)).toBeNull(); // not on this roster
    expect(resolvePlayerRef("m2", 1, ref, ["p2"], ENV)).toBeNull();
    expect(resolvePlayerRef("m1", 2, ref, ["p2"], ENV)).toBeNull();
    expect(resolvePlayerRef("m1", 1, "p2", ["p2"], ENV)).toBeNull(); // a raw id is not a reference
  });
});

describe("roster display names", () => {
  it("first name + last initial, extended only when two players would look the same", async () => {
    vi.doUnmock("@/lib/matchLink");
    const { displayNames } = await vi.importActual<typeof import("@/lib/matchLink")>("@/lib/matchLink");
    const names = displayNames([
      { id: "a", firstName: "John", lastName: "Smith" },
      { id: "b", firstName: "John", lastName: "Smythe" },
      { id: "c", firstName: "Jane", lastName: "Smith" },
      { id: "d", firstName: "Ann", lastName: "" },
      { id: "e", firstName: "Sam", lastName: "Lee" },
      { id: "f", firstName: "Sam", lastName: "Lee" },
    ]);
    expect([...names.values()]).toEqual(["John Smi.", "John Smy.", "Jane S.", "Ann", "Sam Lee", "Sam Lee (2)"]);
  });
});

describe("same-origin check", () => {
  const req = (origin: string | null, url = "https://teambalancepro.com/api/share/match/attendance") => new Request(url, { method: "POST", headers: origin ? { origin } : {} });
  it("accepts this deployment's origin (or APP_BASE_URL) only", () => {
    expect(isSameOrigin(req("https://teambalancepro.com"), {})).toBe(true);
    expect(isSameOrigin(req("https://preview.example.app", "http://internal/api"), { APP_BASE_URL: "https://preview.example.app" })).toBe(true);
    expect(isSameOrigin(req("https://evil.example"), {})).toBe(false);
    expect(isSameOrigin(req(null), {})).toBe(false);
    expect(isSameOrigin(req("null"), {})).toBe(false);
  });
});

describe("anonymous endpoints: guards before any work", () => {
  beforeEach(() => {
    rateLimited.read = false;
    rateLimited.write = false;
    answerThroughMatchLink.mockReset();
    matchLinkView.mockReset();
  });
  afterEach(() => vi.clearAllMocks());
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json", origin: "http://localhost" }) =>
    new Request("http://localhost/api/share/match/attendance", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const valid = { token: "t".repeat(43), matchId: "m1", playerRef: "r".repeat(22), status: "PLAYING" };

  it("answer: JSON only (415), same origin only (403), rate limited (429), allowed values only (400)", async () => {
    expect((await answerRoute.POST(post("status=PLAYING", { "Content-Type": "application/x-www-form-urlencoded", origin: "http://localhost" }))).status).toBe(415);
    expect((await answerRoute.POST(post(valid, { "Content-Type": "application/json", origin: "https://evil.example" }))).status).toBe(403);
    rateLimited.write = true;
    expect((await answerRoute.POST(post(valid))).status).toBe(429);
    rateLimited.write = false;
    expect((await answerRoute.POST(post({ ...valid, status: "ATTENDING" }))).status).toBe(400);
    expect(answerThroughMatchLink).not.toHaveBeenCalled();
  });

  it("answer: invalid link / reference → the generic 404; closed / canceled → 409", async () => {
    answerThroughMatchLink.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect(await (await answerRoute.POST(post(valid))).json()).toEqual({ error: "This link is not valid." });
    answerThroughMatchLink.mockResolvedValueOnce({ ok: false, reason: "closed" });
    expect((await answerRoute.POST(post(valid))).status).toBe(409);
    answerThroughMatchLink.mockResolvedValueOnce({ ok: false, reason: "canceled" });
    expect((await answerRoute.POST(post(valid))).status).toBe(409);
  });

  it("view: rate limited (429), never cached or indexed", async () => {
    rateLimited.read = true;
    const limited = await viewRoute.POST(new Request("http://localhost/api/share/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(limited.status).toBe(429);
    rateLimited.read = false;
    const r = await viewRoute.POST(new Request("http://localhost/api/share/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(r.status).toBe(404);
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("search indexing", () => {
  it("robots.txt disallows every player-facing / private surface and keeps marketing indexable", () => {
    const r = robots();
    const rule = (Array.isArray(r.rules) ? r.rules[0] : r.rules)!;
    expect(rule.allow).toBe("/");
    for (const p of ["/share", "/g/", "/api/", "/admin", "/me", "/claim"]) expect(rule.disallow).toContain(p);
    expect(PRIVATE_PREFIXES).not.toContain("/");
    expect(PRIVATE_PREFIXES).not.toContain("/login");
  });

  it("player-facing pages send noindex (headers + metadata), PUBLIC group pages included", async () => {
    const cfg = (await import(path.join(process.cwd(), "next.config.js"))) as { default?: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }; headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const headers = await (cfg.default ?? cfg).headers!();
    const sources = headers.map((h) => h.source);
    for (const s of ["/share", "/share/:path*", "/g/:path*", "/me/:path*", "/claim"]) expect(sources).toContain(s);
    for (const h of headers) expect(h.headers).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
    expect(read("src/app/g/[organizationSlug]/[groupSlug]/layout.tsx")).toContain("robots: { index: false, follow: false }");
    for (const f of ["src/app/share/page.tsx", "src/app/share/m/[matchId]/page.tsx", "src/app/g/[organizationSlug]/[groupSlug]/m/[matchId]/page.tsx"]) expect(read(f), f).toContain("robots: { index: false, follow: false }");
  });
});
