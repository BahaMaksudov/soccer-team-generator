-- UI-2 — Google sign-in: accounts created through Google have no password.
-- Metadata-only change; existing rows (all with a bcrypt hash) are untouched.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
