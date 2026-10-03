import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";

/**
 * UI-2 — redesigned authentication screens + real Google sign-in.
 * Presentation is ported from the approved Lovable screens; behavior is the
 * production NextAuth flow (no mock auth, delays, fake success, role picker,
 * dead links or Lovable preview infrastructure).
 */

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
  usePathname: () => "/login",
  redirect: (u: string) => {
    throw new Error(`redirect(${u})`);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const nextAuthReact = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next-auth/react", () => nextAuthReact);
const invitations = vi.hoisted(() => ({ getInvitationPreview: vi.fn() }));
vi.mock("@/lib/invitations", () => invitations);

import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import { authErrorMessage } from "@/lib/authErrors";
import { googleAuthConfig, isGoogleAuthConfigured, resolveGoogleSignIn, verifiedGoogleEmail, type GoogleUserStore } from "@/lib/googleAuth";
import { PASSWORD_MIN_LENGTH } from "@/lib/accounts";

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/<[^>]+>/g, "").trim() }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

const renderLogin = () => renderToStaticMarkup(createElement(LoginPage));
const renderSignup = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  nav.params = new URLSearchParams();
  vi.unstubAllEnvs();
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("Google provider configuration", () => {
  it("is enabled only when BOTH client id and secret are set (blank counts as missing)", () => {
    expect(googleAuthConfig({})).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_ID: "id" })).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
    expect(googleAuthConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(isGoogleAuthConfigured({})).toBe(false);
  });

  it("authOptions registers the Google provider only when configured; Credentials stays first", async () => {
    vi.resetModules();
    const without = (await import("@/lib/authOptions")).authOptions.providers.map((p) => p.id);
    expect(without).toEqual(["credentials"]);
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.resetModules();
    const { authOptions } = await import("@/lib/authOptions");
    expect(authOptions.providers.map((p) => p.id)).toEqual(["credentials", "google"]);
    expect(authOptions.pages).toEqual({ signIn: "/login", error: "/login" });
    expect(authOptions.session?.strategy).toBe("jwt");
  });

  it("no secret values in source; .env.example lists the variable NAMES only", () => {
    const example = read(".env.example");
    expect(example).toMatch(/^GOOGLE_CLIENT_ID=""$/m);
    expect(example).toMatch(/^GOOGLE_CLIENT_SECRET=""$/m);
    for (const f of ["src/lib/googleAuth.ts", "src/lib/authOptions.ts"]) expect(read(f)).not.toMatch(/apps\.googleusercontent\.com|GOCSPX-/);
  });
});

describe("Google identity resolution (provider boundary mocked)", () => {
  const row = (over: Partial<{ id: string; email: string; name: string | null; emailVerifiedAt: Date | null }> = {}) => ({
    id: "u1",
    email: "a@example.com",
    name: "A",
    emailVerifiedAt: new Date("2026-01-01"),
    ...over,
  });
  const store = (existing: ReturnType<typeof row> | null, createImpl?: () => Promise<ReturnType<typeof row>>) => {
    const db = {
      user: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(createImpl ?? (async (args: { data: { email: string; name: string | null } }) => row({ id: "new", email: args.data.email, name: args.data.name }))),
      },
    };
    return db as typeof db & GoogleUserStore;
  };

  it("requires Google's email_verified === true and normalizes the email", () => {
    expect(verifiedGoogleEmail({ email: " A@Example.COM ", email_verified: true })).toBe("a@example.com");
    for (const p of [{ email: "a@example.com", email_verified: false }, { email: "a@example.com", email_verified: "true" }, { email: "a@example.com" }, { email_verified: true }, { email: "not-an-email", email_verified: true }, null])
      expect(verifiedGoogleEmail(p)).toBeNull();
  });

  it("existing VERIFIED User → that same User, nothing written", async () => {
    const db = store(row());
    expect(await resolveGoogleSignIn({ email: "A@example.com", email_verified: true, name: "Other" }, db)).toEqual({ ok: true, user: { id: "u1", email: "a@example.com", name: "A" }, created: false });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("existing UNVERIFIED User → refused, nothing written", async () => {
    const db = store(row({ emailVerifiedAt: null }));
    expect(await resolveGoogleSignIn({ email: "a@example.com", email_verified: true }, db)).toEqual({ ok: false, code: "AccountEmailUnverified" });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("no User → creates one: verified now, Google name (trimmed, ≤100), passwordHash NULL — never a fake password", async () => {
    const db = store(null);
    const now = new Date("2026-10-03T00:00:00Z");
    const r = await resolveGoogleSignIn({ email: "new@example.com", email_verified: true, name: `  ${"N".repeat(150)} ` }, db, now);
    expect(r).toMatchObject({ ok: true, created: true });
    expect(db.user.create).toHaveBeenCalledWith({
      data: { email: "new@example.com", name: "N".repeat(100), passwordHash: null, emailVerifiedAt: now },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
  });

  it("unverified Google email never touches the database", async () => {
    const db = store(null);
    expect(await resolveGoogleSignIn({ email: "x@example.com", email_verified: false }, db)).toEqual({ ok: false, code: "GoogleEmailUnverified" });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("a concurrent create (unique violation) resolves to the row that won, under the same rules", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    const db = store(null, async () => {
      throw p2002;
    });
    db.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: "winner", emailVerifiedAt: null }));
    expect(await resolveGoogleSignIn({ email: "a@example.com", email_verified: true }, db)).toEqual({ ok: false, code: "AccountEmailUnverified" });
  });
});

describe("Sign In screen", () => {
  it("approved layout and copy; Sign In, Create an account and Back to home routes", () => {
    const html = renderLogin();
    const t = text(html);
    for (const s of ["Welcome back to game day.", "Sign in", "Email address", "Password", "Sign In", "New to Team Balance Pro?", "Just here for your game?", "Back to home"])
      expect(t).toContain(s);
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    const l = links(html);
    expect(l.find((x) => x.text === "Create an account")?.href).toBe("/signup");
    expect(l.find((x) => x.text === "Back to home")?.href).toBe("/");
    expect(html).toMatch(/aria-label="Show password"/);
    expect(html).toMatch(/autoComplete="current-password"|autocomplete="current-password"/i);
  });

  it("no fake controls: no Keep me signed in, no Forgot password (no reset flow exists), no Terms/Privacy, no role picker", () => {
    const t = text(renderLogin()).toLowerCase();
    for (const s of ["keep me signed in", "forgot", "reset", "terms", "privacy", "role", "owner", "organizer account"]) expect(t, s).not.toContain(s);
    expect(fs.existsSync(path.join(root, "src/app/forgot-password"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/app/api/forgot-password"))).toBe(false);
  });

  it("Continue with Google + divider appear only when Google is configured", () => {
    expect(text(renderLogin())).not.toContain("Continue with Google");
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const t = text(renderLogin());
    expect(t).toContain("Continue with Google");
    expect(t).toContain("or continue with email");
  });

  it("OAuth errors: known codes map to fixed text; the raw query value is never echoed", () => {
    nav.params = new URLSearchParams({ error: "AccountEmailUnverified" });
    expect(text(renderLogin())).toContain("isn't verified yet");
    nav.params = new URLSearchParams({ error: "<script>alert(1)</script>" });
    const html = renderLogin();
    expect(html).not.toContain("alert(1)");
    expect(text(html)).toContain("Sign-in didn't complete");
    expect(authErrorMessage(null)).toBeNull();
    expect(authErrorMessage("toString")).toBe("Sign-in didn't complete. Please try again.");
    expect(authErrorMessage("OAuthCallback")).toBe("Sign-in didn't complete. Please try again.");
  });
});

describe("Create Account screen", () => {
  it("approved layout and copy with the REAL password rule; routes", async () => {
    const html = await renderSignup();
    const t = text(html);
    for (const s of ["Organize better games from day one.", "Create your account", "Full name", "Email address", "Password", "Confirm password", "Create Account", "Already have an account?", "Back to home"])
      expect(t).toContain(s);
    expect(t).toContain(`At least ${PASSWORD_MIN_LENGTH} characters.`);
    expect(html).toContain(`minLength="${PASSWORD_MIN_LENGTH}"`);
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(links(html).find((x) => x.text === "Sign in")?.href).toBe("/login");
  });

  it("no role picker, no Terms/Privacy dead links", async () => {
    const html = await renderSignup();
    const t = text(html).toLowerCase();
    for (const s of ["role", "owner", "admin", "member", "terms", "privacy"]) expect(t, s).not.toContain(s);
    expect(html).not.toMatch(/<select|type="radio"/);
    expect(links(html).every((l) => l.href.startsWith("/") || l.href.startsWith("#"))).toBe(true);
    expect(links(html).some((l) => l.href === "#" || l.href === "")).toBe(false);
  });

  it("invitation: email fixed to the invitation, Sign in continues to the invitation", async () => {
    invitations.getInvitationPreview.mockResolvedValueOnce({ status: "valid", email: "inv@example.com", organizationName: "Eagles" });
    const html = await renderSignup({ invite: "tok123" });
    expect(text(html)).toContain("You were invited to join Eagles");
    expect(html).toMatch(/value="inv@example.com"[^>]*readOnly|readOnly[^>]*value="inv@example.com"/i);
    expect(links(html).find((x) => x.text === "Sign in")?.href).toBe("/login?callbackUrl=%2Finvite%2Ftok123");
  });

  it("Continue with Google appears only when configured", async () => {
    expect(text(await renderSignup())).not.toContain("Continue with Google");
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const t = text(await renderSignup());
    expect(t).toContain("Continue with Google");
    expect(t).toContain("or create an account with email");
  });
});

describe("no mock authentication / Lovable infrastructure", () => {
  const files = [
    "src/app/login/page.tsx",
    "src/app/login/LoginClient.tsx",
    "src/app/signup/page.tsx",
    "src/app/signup/SignupClient.tsx",
    "src/app/verify-email/page.tsx",
    "src/app/verify-email/ResendVerification.tsx",
    "src/app/verify-email/[token]/page.tsx",
    "src/app/verify-email/[token]/VerifyEmailButton.tsx",
    "src/components/auth/AuthLayout.tsx",
    "src/components/auth/fields.tsx",
    "src/components/auth/parts.tsx",
    "src/lib/googleAuth.ts",
  ];
  it("no simulated delays, fake success, prototype hooks, TanStack/Vite or runtime Google Fonts", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bwait\(|setTimeout|Prototype|"You're in"|Signed in\.|AppPreview|design-review|@tanstack|from ["']vite|fonts\.googleapis|password === "wrong"|localStorage|sessionStorage/);
    }
  });
  it("the Google button performs the real NextAuth redirect", () => {
    expect(read("src/components/auth/fields.tsx")).toContain('signIn("google", { callbackUrl })');
  });
  it("credentials sign-in still uses the real NextAuth Credentials provider with a sanitized callback", () => {
    const src = read("src/app/login/LoginClient.tsx");
    expect(src).toContain('signIn("credentials", { email, password, redirect: false, callbackUrl })');
    expect(src).toContain('safeCallbackPath(sp.get("callbackUrl"))');
    expect(src).toContain('"Invalid email or password."');
  });
  it("sign-up still posts to /api/signup and lands on Check your email", () => {
    const src = read("src/app/signup/SignupClient.tsx");
    expect(src).toContain('fetch("/api/signup"');
    expect(src).toContain("/verify-email");
  });
});
