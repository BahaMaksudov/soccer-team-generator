import { describe, it, expect, vi } from "vitest";
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
const NO_LEGACY = {};

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
    const user = await authenticateCredentials("  ADMIN@uccne.com ", PASSWORD, db([OWNER]), NO_LEGACY);
    expect(user).toEqual({ id: "user-owner", email: "admin@uccne.com", name: "Bahrom Maksudov" });
    expect(Object.keys(user!).sort()).toEqual(["email", "id", "name"]); // never passwordHash
  });

  it("wrong password → null", async () => {
    expect(await authenticateCredentials(OWNER.email, "wrong-password", db([OWNER]), NO_LEGACY)).toBeNull();
  });

  it("unknown email → null (same outcome as a wrong password)", async () => {
    expect(await authenticateCredentials("nobody@example.com", PASSWORD, db([OWNER]), NO_LEGACY)).toBeNull();
  });

  it("missing email or password → null without a lookup", async () => {
    const d = db([OWNER]);
    expect(await authenticateCredentials("", PASSWORD, d, NO_LEGACY)).toBeNull();
    expect(await authenticateCredentials(OWNER.email, "", d, NO_LEGACY)).toBeNull();
    expect(d.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("authenticateCredentials — transitional ADMIN_PASSWORD_HASH fallback", () => {
  const legacyEnv = { ADMIN_EMAIL: " Admin@UCCNE.com ", ADMIN_PASSWORD_HASH: LEGACY_HASH };
  const diverged: Row = { ...OWNER, passwordHash: bcrypt.hashSync("some-other-password", 4) };

  it("lets the EXISTING User matching ADMIN_EMAIL sign in with the env password, as that DB User", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([diverged]), legacyEnv);
    expect(user).toEqual({ id: "user-owner", email: "admin@uccne.com", name: "Bahrom Maksudov" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/\$2[aby]\$|legacy-env-password/);
    warn.mockRestore();
  });

  it("never creates or impersonates a User: no DB row → null even with the correct env password", async () => {
    expect(await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([]), legacyEnv)).toBeNull();
  });

  it("applies only to ADMIN_EMAIL — another User cannot use the env password", async () => {
    const other: Row = { id: "u2", email: "someone@example.com", name: null, passwordHash: HASH };
    expect(await authenticateCredentials(other.email, LEGACY_PASSWORD, db([other]), legacyEnv)).toBeNull();
  });

  it("is disabled when the env vars are not set", async () => {
    expect(await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([diverged]), NO_LEGACY)).toBeNull();
    expect(await authenticateCredentials(OWNER.email, LEGACY_PASSWORD, db([diverged]), { ADMIN_EMAIL: OWNER.email })).toBeNull();
  });

  it("a wrong password fails both paths", async () => {
    expect(await authenticateCredentials(OWNER.email, "wrong-password", db([diverged]), legacyEnv)).toBeNull();
  });
});

// =================================================================
// M5.1 — shared current-password matcher + Change Password schema
// =================================================================
import { matchUserPassword } from "@/lib/accounts";
import { changePasswordSchema } from "@/lib/changePassword";

describe("matchUserPassword — one check for login and Change Password", () => {
  const legacyEnv = { ADMIN_EMAIL: " Admin@UCCNE.com ", ADMIN_PASSWORD_HASH: LEGACY_HASH };
  const owner = { email: "admin@uccne.com", passwordHash: HASH };

  it("database hash first", async () => {
    expect(await matchUserPassword(owner, PASSWORD, legacyEnv)).toBe("database");
  });
  it("legacy only for the ADMIN_EMAIL User with both env vars set", async () => {
    expect(await matchUserPassword(owner, LEGACY_PASSWORD, legacyEnv)).toBe("legacy");
    expect(await matchUserPassword({ ...owner, email: "someone@example.com" }, LEGACY_PASSWORD, legacyEnv)).toBeNull();
    expect(await matchUserPassword(owner, LEGACY_PASSWORD, {})).toBeNull();
    expect(await matchUserPassword(owner, LEGACY_PASSWORD, { ADMIN_EMAIL: owner.email })).toBeNull();
    expect(await matchUserPassword(owner, LEGACY_PASSWORD, { ADMIN_PASSWORD_HASH: LEGACY_HASH })).toBeNull();
  });
  it("wrong / empty password → null", async () => {
    expect(await matchUserPassword(owner, "wrong-password", legacyEnv)).toBeNull();
    expect(await matchUserPassword(owner, "", legacyEnv)).toBeNull();
  });
});

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
