import { describe, it, expect } from "vitest";
import { createInvitationSchema, generateInvitationToken, hashInvitationToken } from "@/lib/invitations";

describe("invitation tokens", () => {
  it("are 256-bit random base64url strings, unique per call", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("are stored only as a SHA-256 hash that does not contain the token", () => {
    const t = generateInvitationToken();
    const h = hashInvitationToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashInvitationToken(t)).toBe(h);
  });
});

describe("createInvitationSchema", () => {
  it("normalizes the email and allows only ADMIN / MEMBER", () => {
    expect(createInvitationSchema.parse({ email: " Bob@Example.COM ", role: "MEMBER" })).toEqual({ email: "bob@example.com", role: "MEMBER" });
    expect(createInvitationSchema.safeParse({ email: "bob@example.com", role: "OWNER" }).success).toBe(false);
  });

  it("strips client-supplied organization/token fields", () => {
    expect(
      createInvitationSchema.parse({ email: "bob@example.com", role: "ADMIN", organizationId: "other-org", tokenHash: "x" })
    ).toEqual({ email: "bob@example.com", role: "ADMIN" });
  });
});
