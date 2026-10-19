import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { clientAddress, normalizeIp, rateLimitDigest } from "@/lib/rateLimitKeys";
import { authErrorMessage } from "@/lib/authErrors";

/** M12-A — rate-limit keys: address normalization, proxy trust, keyed digests, outward messages. */
describe("normalizeIp", () => {
  it("IPv4 (ports stripped), IPv4-mapped IPv6 → IPv4, invalid → null", () => {
    expect(normalizeIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    for (const bad of ["", "unknown", "999.1.1.1", "203.0.113", "<script>", "1.2.3.4, 5.6.7.8"]) expect(normalizeIp(bad)).toBeNull();
  });
  it("IPv6 grouped by /64 (brackets, ports, zone ids, case, :: compression)", () => {
    expect(normalizeIp("2001:DB8:85a3:0000:1111:2222:3333:4444")).toBe("2001:db8:85a3:0::/64");
    expect(normalizeIp("2001:db8:85a3::9")).toBe("2001:db8:85a3:0::/64");
    expect(normalizeIp("[2001:db8:85a3:0:ffff::1]:443")).toBe("2001:db8:85a3:0::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeIp("2001:db8:85a3:1::1")).not.toBe(normalizeIp("2001:db8:85a3:0::1")); // different /64
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
  });
});

describe("clientAddress — forwarding headers trusted only behind a trusted proxy", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("not on Vercel (and not opted in): every request shares one bucket — a spoofed header can't choose its own", () => {
    expect(clientAddress(h({ "x-forwarded-for": "1.1.1.1" }), {})).toBe("untrusted-proxy");
    expect(clientAddress(h({ "x-real-ip": "2.2.2.2" }), {})).toBe("untrusted-proxy");
  });
  it("on Vercel: X-Real-IP first, else the first X-Forwarded-For hop (Vercel overwrites it); normalized", () => {
    const env = { VERCEL: "1" };
    expect(clientAddress(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9" }), env)).toBe("203.0.113.7");
    expect(clientAddress(h({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" }), env)).toBe("203.0.113.8");
    expect(clientAddress(h({ "x-forwarded-for": "2001:db8:1:2:aaaa::1" }), env)).toBe("2001:db8:1:2::/64");
    expect(clientAddress(h({}), env)).toBe("unknown");
    expect(clientAddress({ "x-real-ip": "203.0.113.9" }, env)).toBe("203.0.113.9"); // NextAuth passes a plain object
    expect(clientAddress(h({ "x-forwarded-for": "198.51.100.1" }), { TRUST_PROXY_HEADERS: "true" })).toBe("198.51.100.1");
  });
});

describe("rateLimitDigest", () => {
  it("keyed: RATE_LIMIT_HASH_SECRET first, else NEXTAUTH_SECRET; different keys / kinds → different digests; never the value", () => {
    const a = rateLimitDigest("ip", "203.0.113.7", { NEXTAUTH_SECRET: "s1" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203");
    expect(rateLimitDigest("ip", "203.0.113.7", { NEXTAUTH_SECRET: "s2" })).not.toBe(a);
    expect(rateLimitDigest("ip", "203.0.113.7", { NEXTAUTH_SECRET: "s1", RATE_LIMIT_HASH_SECRET: "d" })).not.toBe(a);
    expect(rateLimitDigest("login-email", "203.0.113.7", { NEXTAUTH_SECRET: "s1" })).not.toBe(a);
  });
});

describe("outward behavior", () => {
  it("limit / unavailable messages are fixed, reveal no thresholds and nothing about the account", () => {
    for (const code of ["LoginRateLimited", "LoginUnavailable"]) {
      const m = authErrorMessage(code)!;
      expect(m).not.toMatch(/\d|account exists|no account|registered/i);
    }
    const login = fs.readFileSync(path.join(process.cwd(), "src/app/login/LoginClient.tsx"), "utf8");
    expect(login).toContain('res.error === "LoginRateLimited" || res.error === "LoginUnavailable" ? authErrorMessage(res.error) : "Invalid email or password."');
  });
});
