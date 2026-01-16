/*
  Warnings:

  - A unique constraint covering the columns `[telegramUserId]` on the table `Player` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "telegramUserId" BIGINT,
ADD COLUMN     "telegramUsername" TEXT;

-- CreateTable
CREATE TABLE "TelegramPoll" (
    "pollId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" BIGINT,
    "question" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPoll_pkey" PRIMARY KEY ("pollId")
);

-- CreateTable
CREATE TABLE "TelegramPollAnswer" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "optionIdsJson" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPollAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramPollAnswer_pollId_userId_key" ON "TelegramPollAnswer"("pollId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_telegramUserId_key" ON "Player"("telegramUserId");

-- AddForeignKey
ALTER TABLE "TelegramPollAnswer" ADD CONSTRAINT "TelegramPollAnswer_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "TelegramPoll"("pollId") ON DELETE CASCADE ON UPDATE CASCADE;
