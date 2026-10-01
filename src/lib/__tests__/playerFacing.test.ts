import { describe, it, expect } from "vitest";
import { toPlayerFacingTeams, playerDisplayName } from "@/lib/playerFacing";

const SNAPSHOT = JSON.stringify([
  {
    teamNumber: 1,
    secretTeamField: "x",
    players: [
      { id: "p1", firstName: "Doni", lastName: "Alpha", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5, telegramUserId: "777", telegramUsername: "doni", email: "d@x.com", userId: "u1", groupId: "g1" },
    ],
  },
]);

describe("toPlayerFacingTeams — explicit allow-list", () => {
  it("keeps only team number, names and position", () => {
    expect(toPlayerFacingTeams(SNAPSHOT)).toEqual([
      { teamNumber: 1, players: [{ firstName: "Doni", lastName: "Alpha", position: "GOALKEEPER" }] },
    ]);
  });

  it("never carries rating, stamina, ids, Telegram identity, email or extra fields", () => {
    const out = JSON.stringify(toPlayerFacingTeams(SNAPSHOT));
    for (const banned of ["rating", "EXCELLENT", "stamina", "telegram", "777", "doni\"", "email", "d@x.com", "userId", "groupId", "\"id\"", "p1", "secretTeamField"]) {
      expect(out, banned).not.toContain(banned);
    }
  });

  it("malformed or hostile input yields safe output", () => {
    expect(toPlayerFacingTeams("not json")).toEqual([]);
    expect(toPlayerFacingTeams("{}")).toEqual([]);
    expect(toPlayerFacingTeams(JSON.stringify([{ teamNumber: "1", players: [] }, null, { teamNumber: 2, players: [5, { firstName: 3 }] }]))).toEqual([
      { teamNumber: 2, players: [{ firstName: "", lastName: "", position: null }] },
    ]);
  });

  it("display name falls back to Unknown", () => {
    expect(playerDisplayName({ firstName: " ", lastName: null })).toBe("Unknown");
    expect(playerDisplayName({ firstName: "A", lastName: "B" })).toBe("A B");
  });
});
