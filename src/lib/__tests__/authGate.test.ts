import { describe, it, expect, vi } from "vitest";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

import { authGateDecision, PROTECTED_MATCHER } from "@/lib/authGate";
import { config } from "@/middleware";

describe("authGateDecision (middleware)", () => {
  it("lets authenticated requests through", () => {
    expect(authGateDecision("/admin", "", true)).toEqual({ kind: "next" });
    expect(authGateDecision("/api/admin/organizations", "", true)).toEqual({ kind: "next" });
  });

  it("unauthenticated APIs get 401, never a login page", () => {
    expect(authGateDecision("/api/admin/o/org/g/grp/players", "", false)).toEqual({ kind: "unauthorized" });
    expect(authGateDecision("/api/invitations/accept", "", false)).toEqual({ kind: "unauthorized" });
  });

  it("unauthenticated pages go to /login with the internal callback preserved", () => {
    expect(authGateDecision("/admin/o/org/g/grp", "?tab=players", false)).toEqual({
      kind: "login",
      loginPath: "/login?callbackUrl=%2Fadmin%2Fo%2Forg%2Fg%2Fgrp%3Ftab%3Dplayers",
    });
    expect(authGateDecision("/onboarding", "", false)).toEqual({ kind: "login", loginPath: "/login?callbackUrl=%2Fonboarding" });
  });

  it("middleware protects exactly the documented paths (admin pages/APIs, onboarding, invitation acceptance)", () => {
    expect(config.matcher).toEqual(PROTECTED_MATCHER);
  });
});
