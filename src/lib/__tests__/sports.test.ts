import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SPORTS, SPORT_KEYS, findSport, isValidRoleKey, requireSport, roleLabel, sportMessaging, UnknownSportError } from "@/lib/sports";
import { createWorkspaceSchema, createGroupSchema } from "@/lib/workspaces";
import { teamsContent } from "@/lib/messaging";

describe("M7 sport registry", () => {
  it("supports exactly the five locked sports with stable keys", () => {
    expect(SPORT_KEYS).toEqual(["soccer", "basketball", "volleyball", "flag_football", "other"]);
    expect(SPORTS.map((s) => s.label)).toEqual(["Soccer", "Basketball", "Volleyball", "Flag Football", "Other"]);
  });

  it("every definition is internally consistent", () => {
    for (const s of SPORTS) {
      const keys = s.roles.map((r) => r.key);
      expect(new Set(keys).size, s.key).toBe(keys.length);
      expect(keys, s.key).toContain(s.defaultRoleKey);
      if (s.newPlayerRoleKey) expect(keys, s.key).toContain(s.newPlayerRoleKey);
      for (const r of s.roleRules) {
        expect(keys, `${s.key} rule ${r.roleKey}`).toContain(r.roleKey);
        expect(r.perTeam).toBeGreaterThanOrEqual(1);
      }
      expect(new Set(s.roleRules.map((r) => r.roleKey)).size).toBe(s.roleRules.length);
      for (const k of keys) expect(k).toMatch(/^[A-Z][A-Z0-9_]{0,39}$/);
    }
  });

  it("locked role sets, defaults, rules and stamina coefficients", () => {
    const roles = (k: string) => findSport(k)!.roles.map((r) => r.key);
    expect(roles("soccer")).toEqual(["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD", "ANY"]);
    expect(roles("basketball")).toEqual(["GUARD", "WING", "BIG", "ANY"]);
    expect(roles("volleyball")).toEqual(["SETTER", "HITTER", "MIDDLE", "LIBERO", "ALL_AROUND"]);
    expect(roles("flag_football")).toEqual(["QUARTERBACK", "RECEIVER", "RUSHER_LINE", "DEFENDER", "ATHLETE"]);
    expect(roles("other")).toEqual(["PLAYER"]);
    expect(SPORTS.map((s) => [s.key, s.defaultRoleKey])).toEqual([
      ["soccer", "ANY"], ["basketball", "ANY"], ["volleyball", "ALL_AROUND"], ["flag_football", "ATHLETE"], ["other", "PLAYER"],
    ]);
    expect(SPORTS.map((s) => [s.key, s.roleRules])).toEqual([
      ["soccer", [{ roleKey: "GOALKEEPER", perTeam: 1, mode: "SEED", warnWhenShort: true }]],
      ["basketball", [{ roleKey: "BIG", perTeam: 1, mode: "SPREAD", warnWhenShort: false }]],
      ["volleyball", [{ roleKey: "SETTER", perTeam: 1, mode: "SPREAD", warnWhenShort: true }]],
      ["flag_football", [{ roleKey: "QUARTERBACK", perTeam: 1, mode: "SPREAD", warnWhenShort: true }]],
      ["other", []],
    ]);
    expect(SPORTS.map((s) => s.defaults.staminaCoef)).toEqual([1, 1, 0.5, 1, 1]);
    // Soccer weights are the pre-M7 defaults.
    expect(Object.fromEntries(findSport("soccer")!.roles.map((r) => [r.key, r.defaultWeight]))).toEqual({ GOALKEEPER: 2, DEFENDER: 1, MIDFIELDER: 2, FORWARD: 2, ANY: 2 });
  });

  it("only soccer knows about goalkeepers; SEED is soccer-only by default", () => {
    for (const s of SPORTS.filter((x) => x.key !== "soccer")) {
      expect(JSON.stringify(s), s.key).not.toMatch(/goal ?keeper|GOALKEEPER/i);
      expect(s.roleRules.every((r) => r.mode !== "SEED"), s.key).toBe(true);
    }
  });

  it("roles are validated per sport (no cross-sport roles)", () => {
    expect(isValidRoleKey(findSport("basketball")!, "GOALKEEPER")).toBe(false);
    expect(isValidRoleKey(findSport("soccer")!, "SETTER")).toBe(false);
    expect(isValidRoleKey(findSport("volleyball")!, "SETTER")).toBe(true);
    expect(isValidRoleKey(findSport("other")!, "ANY")).toBe(false);
  });

  it("unknown sport fails closed; labels never guess another sport's wording", () => {
    expect(() => requireSport("hockey")).toThrow(UnknownSportError);
    expect(() => requireSport(null)).toThrow(UnknownSportError);
    expect(roleLabel("soccer", "GOALKEEPER")).toBe("Goalkeeper");
    expect(roleLabel("basketball", "GOALKEEPER")).toBe("GOALKEEPER"); // legacy/unknown → raw key
    expect(roleLabel("hockey", "GOALKEEPER")).toBe("GOALKEEPER");
    expect(roleLabel("volleyball", "LIBERO")).toBe("Libero / Defender");
  });

  it("messaging vocabulary and result formats come from the definition", () => {
    expect(SPORTS.map((s) => [s.key, s.messaging.emoji, s.resultFormat.kind])).toEqual([
      ["soccer", "⚽", "POINTS"], ["basketball", "🏀", "POINTS"], ["volleyball", "🏐", "SETS"], ["flag_football", "🏈", "POINTS"], ["other", "🏅", "POINTS"],
    ]);
    expect(findSport("soccer")!.resultFormat).toEqual({ kind: "POINTS", label: "goals" });
    expect(findSport("volleyball")!.resultFormat).toMatchObject({ kind: "SETS", bestOf: 3 });
    for (const k of ["basketball", "volleyball", "flag_football", "other"]) {
      expect(JSON.stringify(sportMessaging(k))).not.toMatch(/⚽|goal|keeper|soccer/i);
    }
    expect(sportMessaging("unknown")).toEqual(findSport("other")!.messaging);
  });

  it("onboarding and Add Group accept only registry sport keys", () => {
    const base = { groupName: "G", timezone: "America/New_York" };
    for (const k of SPORT_KEYS) expect(createGroupSchema.safeParse({ ...base, sportKey: k }).success).toBe(true);
    for (const k of ["american_football", "SOCCER", "", "x"]) expect(createGroupSchema.safeParse({ ...base, sportKey: k }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ ...base, organizationName: "Org", sportKey: "flag_football" }).success).toBe(true);
  });
});

describe("M7 messaging: existing Telegram teams post is byte-identical", () => {
  it("TEAMS_PUBLISHED content keeps the pre-M7 neutral title (contentHash stability)", () => {
    const c = teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "10/5/26", teams: [{ teamNumber: 1, players: [{ firstName: "A", lastName: "B" }] }], viewUrl: null });
    expect(c.title).toBe("\u{1F3DF}\u{FE0F} Generated Teams — 10/5/26");
    expect(c.sections).toEqual([{ heading: "Team #1", items: ["A B"] }]);
  });
});

describe("M7 invariant: Group.sportKey is immutable after creation", () => {
  const root = path.resolve(__dirname, "../../..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(i?test)\.tsx?$/.test(e.name) && !p.includes("__tests__")) out.push(p);
    }
    return out;
  }
  const sources = walk("src").map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")] as const);

  it("no Group update/upsert anywhere writes sportKey", () => {
    for (const [f, src] of sources) {
      for (const m of src.matchAll(/\.group\.(update|updateMany|upsert)\(/g)) {
        const call = src.slice(m.index!, m.index! + 600);
        expect(call, f).not.toMatch(/sportKey/);
      }
    }
  });

  it("sportKey is only ever set inside group.create (onboarding and Add Group)", () => {
    const writers = sources
      .filter(([, src]) => /\.group\.create\(\{[\s\S]{0,400}sportKey: input\.sportKey/.test(src))
      .map(([f]) => f)
      .sort();
    expect(writers).toEqual([path.join("src", "lib", "workspaces.ts")]);
  });
});
