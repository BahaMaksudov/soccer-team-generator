-- CreateTable
CREATE TABLE "TelegramUserLink" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "playerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserLink_userId_key" ON "TelegramUserLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserLink_playerId_key" ON "TelegramUserLink"("playerId");

-- AddForeignKey
ALTER TABLE "TelegramUserLink" ADD CONSTRAINT "TelegramUserLink_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
