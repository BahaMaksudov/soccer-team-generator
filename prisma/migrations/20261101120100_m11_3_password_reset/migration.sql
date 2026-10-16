-- M11.3 — password reset. Additive only: one new nullable column on "User"
-- (NULL for every existing row = no change to any existing session) and one new
-- empty table. No existing row, constraint or index is changed.
--
-- Rollback (after reverting the code that uses it):
--   DROP TABLE "PasswordResetToken"; ALTER TABLE "User" DROP COLUMN "sessionsValidAfter";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101120100_m11_3_password_reset';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionsValidAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
