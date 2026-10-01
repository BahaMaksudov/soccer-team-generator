import { describe, it, expect, vi, afterEach } from "vitest";
import bcrypt from "bcrypt";
import {
  authenticateCredentials,
  hashPassword,
  normalizeEmail,
  passwordSchema,
  signupSchema,
  verifyPassword,
} from "@/lib/accounts";

const PASSWORD = "correct horse battery";
// Cost 4 keeps these fixture hashes fast; production hashing uses cost 12.
const HASH = bcrypt.hashSync(PASSWORD, 4);
const LEGACY_PASSWORD = "legacy-env-password";
const LEGACY_HASH = bcrypt.hashSync(LEGACY_PASSWORD, 4);

type Row = { id: string; email: string; name: string | null; passwordHash: string };
const db = (rows: Row[]) => ({
  user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => rows.find((r) => r.email === where.email) ?? null) },
});
const OWNER: Row = { id: "user-owner", email: "admin@uccne.com", name: "Bahrom Maksudov", passwordHash: HASH };

describe("normalizeEmail / schemas", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Admin@UCCNE.com ")).toBe("admin@uccne.com");
  });

  it("password policy: min 8 characters, max 72 bytes (bcrypt truncation)", () => {
    expect(passwordSchema.safeParse("1234567").success).toBe(false);
    expect(passwordSchema.safeParse("12345678").success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(passwordSchema.safeParse("é".repeat(37)).success).toBe(false); // 74 bytes
  });

  it("signup requires name, valid email, matching confirmation", () => {
    const ok = { name: "Ann", email: "ann@example.com", password: PASSWORD, confirmPassword: PASSWORD };
    expect(signupSchema.safeParse(ok).success).toBe(true);
    expect(signupSchema.safeParse({ ...ok, name: "  " }).success).toBe(false);
    expect(signupSchema.safeParse({ ...ok, email: "not-an-email" }).success).toBe(false);
    expect(signupSchema.safeParse({ ...ok, confirmPassword: "different1" }).success).toBe(false);
  });

  it("with an invite token the client email is not required (the invitation supplies it)", () => {
    expect(signupSchema.safeParse({ name: "Ann", password: PASSWORD, confirmPassword: PASSWORD, inviteToken: "t" }).success).toBe(true);
  });
});

describe("password hashing", () => {
  it("hashes with bcrypt (never plaintext) and verifies", async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).not.toContain(PASSWORD);
    expect(h).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword("wrong-password", h)).toBe(false);
  });

  it("a malformed stored hash fails closed instead of throwing", async () => {
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
  });
});

describe("authenticateCredentials — database-backed login", () => {
  it("authenticates by normalized email + User.passwordHash and returns identity only", async () => {
    const user = await authenticateCredentials("  ADMIN@uccne.com ", PASSWORD, db([OWNER]));
    expect(user).toEqual({ id: "user-owner", email: "admin@uccne.com", name: "Bahrom Maksudov" });
    expect(Object.keys(user!).sort()).toEqual(["email", "id", "name"]); // never passwordHash
  });

  it("wrong password → null", async () => {
    expect(await authenticateCredentials(OWNER.email, "wrong-password", db([OWNER]))).toBeNull();
  });

  it("unknown email → null (same outcome as a wrong password)", async () => {
    expect(await authenticateCredentials("nobody@example.com", PASSWORD, db([OWNER]))).toBeNull();
  });

  it("missing email or password → null without a lookup", async () => {
    const d = db([OWNER]);
    expect(await authenticateCredentials("", PASSWORD, d)).toBeNull();
    expect(await authenticateCredentials(OWNER.email, "", d)).toBeNull();
    expect(d.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("authenticateCredentials — no env-based credentials (legacy fallback retired in M5.1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ADMIN_EMAIL / ADMIN_PASSWORD_HASH are ignored even when set: only User.passwordHash authenticates", async () => {
    vi.stubEnv("ADMIN_EMAIL", OWNER.email);
    vi.stubEnv("ADMIN_PASSWORD_HASH", LEGACY_HASH);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([OWNER]))).toBeNull();
    expect(await authenticateCredentials(OWNER.email, PASSWORD, db([OWNER]))).toMatchObject({ id: "user-owner" });
    expect(await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([]))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// =================================================================
// M5.1 — Change Password schema
// =================================================================
import { changePasswordSchema } from "@/lib/changePassword";

describe("changePasswordSchema", () => {
  const ok = { currentPassword: "old-password-1", newPassword: "new-password-1", confirmPassword: "new-password-1" };
  it("accepts a valid change and strips every other field", () => {
    expect(changePasswordSchema.parse({ ...ok, userId: "x", email: "e@x.com", role: "OWNER", passwordHash: "h" })).toEqual(ok);
  });
  it("rejects mismatch, short, over-long, unchanged and missing current password", () => {
    expect(changePasswordSchema.safeParse({ ...ok, confirmPassword: "nope-nope-1" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ ...ok, newPassword: "short", confirmPassword: "short" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ ...ok, newPassword: "a".repeat(73), confirmPassword: "a".repeat(73) }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ ...ok, newPassword: ok.currentPassword, confirmPassword: ok.currentPassword }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ ...ok, currentPassword: "" }).success).toBe(false);
  });
});
