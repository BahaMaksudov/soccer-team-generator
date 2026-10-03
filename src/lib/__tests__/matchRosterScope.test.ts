import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { visibleRosterIds } from "@/lib/matchRosterScope";

/**
 * M9-B — Match roster presentation with Telegram chat scope:
 *   Player 1 → Chat A, Player 2 → Chat B, Player 3 → Chat A + Chat B, Player 4 → no chat.
 */
const ROSTER = ["p1", "p2", "p3", "p4"];
const SCOPE = { A: ["p1", "p3"], B: ["p2", "p3"] };
const show = (o: Partial<Parameters<typeof visibleRosterIds>[0]>) =>
  visibleRosterIds({ rosterIds: ROSTER, chatSelected: true, scopeIds: [], withMatchState: new Set(), addedIds: [], showAll: false, ...o });

describe("Match roster default scope (Telegram chat)", () => {
  it("no chat selected → every Player (unchanged behavior)", () => {
    expect(show({ chatSelected: false })).toEqual(ROSTER);
  });
  it("Chat A defaults to Players 1 + 3; Chat B to Players 2 + 3 (Player 3 is in both)", () => {
    expect(show({ scopeIds: SCOPE.A })).toEqual(["p1", "p3"]);
    expect(show({ scopeIds: SCOPE.B })).toEqual(["p2", "p3"]);
  });
  it("Player 4 (no chat) can be added to either Match; 'Show all' lists everyone", () => {
    expect(show({ scopeIds: SCOPE.A, addedIds: ["p4"] })).toEqual(["p1", "p3", "p4"]);
    expect(show({ scopeIds: SCOPE.B, addedIds: ["p4"] })).toEqual(["p2", "p3", "p4"]);
    expect(show({ scopeIds: SCOPE.A, showAll: true })).toEqual(ROSTER);
  });
  it("Players with Match state never disappear when the chat changes (attendance, selection, published teams)", () => {
    const withMatchState = new Set(["p2", "p4"]); // e.g. p2 voted from another chat, p4 is in the published teams
    expect(show({ scopeIds: SCOPE.A, withMatchState })).toEqual(["p1", "p2", "p3", "p4"]);
    expect(show({ scopeIds: SCOPE.B, withMatchState })).toEqual(["p2", "p3", "p4"]);
  });
  it("an empty scope still shows everyone with Match state (scope is never an eligibility rule)", () => {
    expect(show({ scopeIds: [], withMatchState: new Set(["p4"]) })).toEqual(["p4"]);
  });
});

describe("M9-B wiring", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("migration #19 creates the partial unique indexes after the columns they use and before dropping the old unique indexes; no data rewrite", () => {
    const sql = read("prisma/migrations/20261005120000_m9b_channel_scope_match_identity/migration.sql");
    const at = (needle: string) => {
      const i = sql.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at(`ADD COLUMN     "disconnectedAt"`)).toBeLessThan(at(`"TelegramChat_chatId_active_key"`));
    expect(at(`"TeamGeneration_groupId_date_legacy_key" ON "TeamGeneration"("groupId", "date") WHERE "matchId" IS NULL`)).toBeLessThan(at(`DROP INDEX "TeamGeneration_groupId_date_key"`));
    expect(at(`"TelegramChat_chatId_active_key" ON "TelegramChat"("chatId") WHERE "disconnectedAt" IS NULL`)).toBeLessThan(at(`DROP INDEX "TelegramChat_chatId_key"`));
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|TRUNCATE)\b/im);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)/i);
  });
  it("Match publishes are addressed by matchId; legacy publishes only touch matchId-NULL rows", () => {
    const core = read("src/lib/publishTeams.ts");
    expect(core).toContain("where: { matchId },");
    expect(core).toContain("where: { groupId: activeGroupId, date: normalizedDate, matchId: null },");
    expect(core).not.toContain("groupId_date");
  });
  it("Telegram posting and sending only use CONNECTED chats; a Match poll posts only that Match's teams", () => {
    expect(read("src/lib/telegramCloseAndPost.ts")).toContain("poll.matchId && generation.matchId !== poll.matchId");
    expect(read("src/lib/telegramCloseAndPost.ts")).toContain("groupId: activeGroupId, disconnectedAt: null");
    expect(read("src/lib/telegramAttendance.ts")).toContain("where: { id: chatRef, groupId, disconnectedAt: null }");
  });
});
