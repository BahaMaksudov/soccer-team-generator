import { describe, it, expect } from "vitest";
import {
  applySelectAllActive,
  deletePublishedPath,
  emptyPlayerForm,
  generateDateFromImportedPoll,
  playerFormFromPlayer,
  playerFormToBody,
  pruneSelection,
  publishedGenerationAfterDelete,
  selectAllActiveState,
  selectedRoleCoverage,
  roleCoverageMessage,
  validatePlayerForm,
  PLAYER_RATINGS,
} from "@/lib/canonicalAdminState";
import { applyImportedPlayerSelection } from "@/lib/telegramImportSelection";
import { playerCreateSchema, playerUpdateSchema } from "@/lib/validation";
import { Rating } from "@prisma/client";
import { soccer } from "@/lib/sports/soccer";
import { basketball } from "@/lib/sports/basketball";
import { volleyball } from "@/lib/sports/volleyball";
import { other } from "@/lib/sports/other";
const SOCCER_ROLES = soccer.roles.map((r) => r.key);

const P = (id: string, over: Partial<{ position: string; isActive: boolean; stamina: number }> = {}) => ({
  id,
  firstName: `F${id}`,
  lastName: `L${id}`,
  position: (over.position ?? "MIDFIELDER") as "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD",
  rating: "GOOD" as const,
  stamina: over.stamina ?? 3,
  isActive: over.isActive ?? true,
});

describe("player form", () => {
  it("options match the Prisma enums exactly", () => {
    // M7: roles come from the sport registry; soccer keeps the four pre-M7 keys (+ ANY).
    expect(SOCCER_ROLES).toEqual(["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD", "ANY"]);
    expect(PLAYER_RATINGS).toEqual(Object.values(Rating));
  });

  it("body carries all six Player fields (incl. stamina, rating, position, isActive) and no tenant ids", () => {
    const body = playerFormToBody({
      firstName: "  Ann ",
      lastName: " Lee ",
      position: "GOALKEEPER",
      rating: "EXCELLENT",
      stamina: 5,
      isActive: false,
    });
    expect(body).toEqual({
      firstName: "Ann",
      lastName: "Lee",
      position: "GOALKEEPER",
      rating: "EXCELLENT",
      stamina: 5,
      isActive: false,
    });
    expect(Object.keys(body)).not.toContain("groupId");
    expect(Object.keys(body)).not.toContain("organizationId");
  });

  it("the body is accepted unchanged by both server schemas (create and update)", () => {
    const body = playerFormToBody({ ...emptyPlayerForm(), firstName: "A", lastName: "B", stamina: 1 });
    expect(playerCreateSchema.parse(body)).toEqual(body);
    expect(playerUpdateSchema.parse(body)).toEqual(body);
  });

  it("defaults: Midfielder, Good, stamina 3, active", () => {
    expect(emptyPlayerForm()).toEqual({
      firstName: "",
      lastName: "",
      position: "MIDFIELDER",
      rating: "GOOD",
      stamina: 3,
      isActive: true,
    });
  });

  it("edit form is pre-filled from the player", () => {
    expect(playerFormFromPlayer(P("1", { position: "FORWARD", stamina: 4, isActive: false }))).toEqual({
      firstName: "F1",
      lastName: "L1",
      position: "FORWARD",
      rating: "GOOD",
      stamina: 4,
      isActive: false,
    });
  });

  it("validation requires names and a 1–5 stamina", () => {
    expect(validatePlayerForm({ ...emptyPlayerForm(), firstName: " ", lastName: "B" }, SOCCER_ROLES)).toMatch(/required/);
    expect(validatePlayerForm({ ...emptyPlayerForm(), firstName: "A", lastName: "B", stamina: 6 }, SOCCER_ROLES)).toMatch(/Stamina/);
    expect(validatePlayerForm({ ...emptyPlayerForm(), firstName: "A", lastName: "B" }, SOCCER_ROLES)).toBeNull();
  });

  it("M7: soccer's Add Player default stays Midfielder; roles are validated per sport", () => {
    expect(emptyPlayerForm().position).toBe("MIDFIELDER");
    expect(emptyPlayerForm("ANY").position).toBe("ANY");
    const basketballRoles = basketball.roles.map((r) => r.key);
    expect(validatePlayerForm({ ...emptyPlayerForm("GOALKEEPER"), firstName: "A", lastName: "B" }, basketballRoles, "Role")).toMatch(/valid role/);
    expect(validatePlayerForm({ ...emptyPlayerForm("BIG"), firstName: "A", lastName: "B" }, basketballRoles, "Role")).toBeNull();
  });
});

describe("shared selection coherence", () => {
  it("deactivating a selected player removes it from the selection", () => {
    const selected = { a: true, b: true };
    expect(pruneSelection(selected, [P("a"), P("b", { isActive: false })])).toEqual({ a: true });
  });

  it("deleting a selected player removes it from the selection", () => {
    expect(pruneSelection({ a: true, gone: true }, [P("a")])).toEqual({ a: true });
  });

  it("unchecked entries are dropped, remaining selection is unchanged", () => {
    expect(pruneSelection({ a: false, b: true }, [P("a"), P("b")])).toEqual({ b: true });
  });

  it("Telegram import still REPLACES the one shared selection, then keeps only active known players", () => {
    const imported = pruneSelection(applyImportedPlayerSelection(["a", "inactive", "foreign"]), [
      P("a"),
      P("b"),
      P("inactive", { isActive: false }),
    ]);
    expect(imported).toEqual({ a: true });
  });

  it("select-all checks every active player and never an inactive one", () => {
    const players = [P("a"), P("b"), P("c", { isActive: false })];
    expect(applySelectAllActive({}, players, true)).toEqual({ a: true, b: true });
    expect(applySelectAllActive({ a: true, b: true }, players, false)).toEqual({});
  });

  it("select-all header state", () => {
    const players = [P("a"), P("b"), P("c", { isActive: false })];
    expect(selectAllActiveState({}, players)).toBe("none");
    expect(selectAllActiveState({ a: true }, players)).toBe("some");
    expect(selectAllActiveState({ a: true, b: true }, players)).toBe("all");
    expect(selectAllActiveState({}, [P("x", { isActive: false })])).toBe("none");
  });
});

describe("role coverage warning (M7; soccer = the legacy goalkeeper rule)", () => {
  const players = [P("g1", { position: "GOALKEEPER" }), P("g2", { position: "GOALKEEPER", isActive: false }), P("m")];
  const gk = (selected: string[], teams: number) => selectedRoleCoverage(soccer, players, selected, teams).find((c) => c.roleKey === "GOALKEEPER")!;

  it("counts selected ACTIVE goalkeepers only", () => {
    expect(gk(["g1", "g2", "m"], 2).available).toBe(1);
  });

  it("warns when selected goalkeepers < team count (same thresholds as before)", () => {
    expect(gk(["g1"], 2)).toMatchObject({ short: true, warn: true });
    expect(gk(["g1"], 1)).toMatchObject({ short: false });
    const three = [P("a", { position: "GOALKEEPER" }), P("b", { position: "GOALKEEPER" }), P("c", { position: "GOALKEEPER" })];
    expect(selectedRoleCoverage(soccer, three, ["a", "b", "c"], 2)[0].short).toBe(false);
    expect(roleCoverageMessage(soccer, gk(["g1"], 3), 3)).toBe("Goalkeepers: 1 available for 3 teams");
  });

  it("other sports never mention goalkeepers; Other has no role checks", () => {
    const vb = selectedRoleCoverage(volleyball, [P("s", { position: "SETTER" })], ["s"], 2);
    expect(vb.map((c) => c.roleKey)).toEqual(["SETTER"]);
    expect(roleCoverageMessage(volleyball, vb[0], 2)).toBe("Setters: 1 available for 2 teams");
    const bb = selectedRoleCoverage(basketball, [P("b", { position: "BIG" })], ["b"], 3);
    expect(roleCoverageMessage(basketball, bb[0], 3)).toBe("Bigs: 1 across 3 teams");
    expect(bb[0].warn).toBe(false);
    expect(selectedRoleCoverage(other, [P("x", { position: "PLAYER" })], ["x"], 2)).toEqual([]);
  });
});

describe("Telegram import → Generate date", () => {
  it("persisted pollDate becomes the Generate date", () => {
    expect(generateDateFromImportedPoll({ persistedPollDate: "2026-09-28" })).toBe("2026-09-28");
  });

  it("null persisted pollDate yields null even when the question/display pollDate has a date", () => {
    const poll = { persistedPollDate: null, pollDate: "2026-09-28", question: "Who is playing on 9/28/26?" };
    expect(generateDateFromImportedPoll(poll)).toBeNull();
  });

  it("missing poll yields null", () => {
    expect(generateDateFromImportedPoll(undefined)).toBeNull();
  });
});

describe("Delete Published Teams", () => {
  it("builds the canonical DELETE path with only the date", () => {
    expect(deletePublishedPath("2026-09-28")).toBe("/publish?date=2026-09-28");
  });

  it("clears publishedGeneration when its date was deleted", () => {
    expect(publishedGenerationAfterDelete({ id: "gen-1", date: "2026-09-28" }, "2026-09-28")).toBeNull();
  });

  it("keeps publishedGeneration when a different date was deleted", () => {
    const pg = { id: "gen-1", date: "2026-09-28" };
    expect(publishedGenerationAfterDelete(pg, "2026-09-21")).toBe(pg);
    expect(publishedGenerationAfterDelete(null, "2026-09-21")).toBeNull();
  });
});
