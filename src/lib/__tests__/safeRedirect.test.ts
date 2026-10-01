import { describe, it, expect } from "vitest";
import { safeAuthRedirect, safeCallbackPath } from "@/lib/safeRedirect";

describe("safeCallbackPath — internal paths only (no open redirect)", () => {
  it.each([
    ["/admin", "/admin"],
    ["/admin/o/org/g/group", "/admin/o/org/g/group"],
    ["/invite/abc_DEF-123?x=1#top", "/invite/abc_DEF-123?x=1#top"],
    ["/onboarding", "/onboarding"],
  ])("keeps %s", (input, expected) => {
    expect(safeCallbackPath(input)).toBe(expected);
  });

  it.each([
    "https://evil.example",
    "http://evil.example/admin",
    "//evil.example",
    "//evil.example/admin",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "admin",
    "",
    "/admin\n//evil.example",
    "/\t/evil.example",
    " /admin",
  ])("rejects %j → /admin", (input) => {
    expect(safeCallbackPath(input)).toBe("/admin");
  });

  it("non-strings fall back", () => {
    expect(safeCallbackPath(null)).toBe("/admin");
    expect(safeCallbackPath(undefined)).toBe("/admin");
    expect(safeCallbackPath(["/admin"])).toBe("/admin");
  });

  it("uses the supplied fallback", () => {
    expect(safeCallbackPath("https://evil.example", "/login")).toBe("/login");
  });
});

describe("safeAuthRedirect — NextAuth redirect callback", () => {
  const base = "https://app.example.com";
  it("keeps same-origin targets", () => {
    expect(safeAuthRedirect("/admin/o/x/g/y", base)).toBe(`${base}/admin/o/x/g/y`);
    expect(safeAuthRedirect(`${base}/invite/t`, base)).toBe(`${base}/invite/t`);
  });
  it("replaces foreign or malformed targets with /admin on the app's own origin", () => {
    expect(safeAuthRedirect("https://evil.example/admin", base)).toBe(`${base}/admin`);
    expect(safeAuthRedirect("//evil.example", base)).toBe(`${base}/admin`);
    expect(safeAuthRedirect("javascript:alert(1)", base)).toBe(`${base}/admin`);
    expect(safeAuthRedirect("https://app.example.com.evil.example/", base)).toBe(`${base}/admin`);
  });
});
