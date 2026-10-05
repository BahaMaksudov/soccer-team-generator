import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SPORTS, findSport } from "@/lib/sports";
import { filterRoster, initials, rosterSummary } from "@/lib/playerRoster";
import { VISIBILITY_LABELS } from "@/lib/organizationGroups";

/**
 * UI-5 — Players + Groups pages. Pure roster rules, sport-registry-driven
 * positions, read-only MEMBER presentation, no bulk actions and no mock data.
 */
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const G = "src/app/admin/o/[organizationSlug]/g/[groupSlug]";
const roster = read(`${G}/players/PlayersRoster.tsx`);
const groupsPage = read("src/app/admin/o/[organizationSlug]/groups/page.tsx");

const P = (id: string, firstName: string, lastName: string, position: string, isActive: boolean) => ({ id, firstName, lastName, position, isActive });
const players = [P("1", "Zoe", "Adams", "DEFENDER", true), P("2", "Amy", "Baker", "FORWARD", false), P("3", "Ben", "Cole", "FORWARD", true), P("4", "Mark", "Mars", "GOALKEEPER", true)];

describe("roster rules (presentation only)", () => {
  it("active first, then by name; search is case-insensitive on the full name", () => {
    expect(filterRoster(players, { q: "", status: "all", role: "all" }).map((p) => p.id)).toEqual(["3", "4", "1", "2"]);
    expect(filterRoster(players, { q: "MAR", status: "all", role: "all" }).map((p) => p.id)).toEqual(["4"]);
    expect(filterRoster(players, { q: "  ", status: "all", role: "all" })).toHaveLength(4);
  });
  it("status and position filters combine", () => {
    expect(filterRoster(players, { q: "", status: "inactive", role: "all" }).map((p) => p.id)).toEqual(["2"]);
    expect(filterRoster(players, { q: "", status: "active", role: "FORWARD" }).map((p) => p.id)).toEqual(["3"]);
  });
  it("summary and initials", () => {
    expect(rosterSummary(players)).toEqual({ total: 4, active: 3, inactive: 1 });
    expect(initials({ firstName: "zoe", lastName: "adams" })).toBe("ZA");
  });
});

describe("positions come from the real sport registry", () => {
  it("each sport's role keys match the domain", () => {
    expect(Object.fromEntries(SPORTS.map((s) => [s.key, s.roles.map((r) => r.key)]))).toEqual({
      soccer: ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD", "ANY"],
      basketball: ["GUARD", "WING", "BIG", "ANY"],
      volleyball: ["SETTER", "HITTER", "MIDDLE", "LIBERO", "ALL_AROUND"],
      flag_football: ["QUARTERBACK", "RECEIVER", "RUSHER_LINE", "DEFENDER", "ATHLETE"],
      other: ["PLAYER"],
    });
    expect(findSport("flag_football")?.label).toBe("American Football");
  });
  it("the Players page renders position options/labels from the Group's sport, never a hard-coded list", () => {
    expect(roster).toContain("sport.roles.map((r) =>");
    expect(roster).toContain("roleLabel(sport.key, key)");
    expect(roster).not.toMatch(/"GOALKEEPER"|"MIDFIELDER"|"GUARD"|"SETTER"|"QUARTERBACK"/);
  });
});

describe("Players page behavior", () => {
  it("uses the existing tenant-bound APIs (same payloads as the group page)", () => {
    expect(roster).toContain('adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" })');
    expect(roster).toContain("JSON.stringify(playerFormToBody(values))");
    expect(roster).toContain("JSON.stringify({ isActive: !p.isActive })");
    expect(roster).toContain('method: "DELETE"');
    expect(read(`${G}/players/page.tsx`)).toContain("if (!context) notFound();");
  });
  it("no bulk actions (no multi-select, no bulk delete/activate)", () => {
    const code = roster.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/selected\.size|Bulk|bulk|Select all|setSelected/);
  });
  it("MEMBER: no Add/Edit/Activate/Delete/Account actions and no skill/stamina (balancing data)", () => {
    for (const marker of ['<Plus aria-hidden="true" /> Add Player', "<th scope=\"col\" className=\"py-2.5 pr-3\">Skill</th>", "<th scope=\"col\" className=\"py-2.5 pr-3\">Stamina</th>", "<Stamina value={Number(p.stamina)} />"]) {
      const i = roster.indexOf(marker);
      expect(i, marker).toBeGreaterThan(-1);
      expect(roster.lastIndexOf("canManage", i), marker).toBeGreaterThan(roster.lastIndexOf("\n\n", i) - 400);
    }
    expect(roster).toContain("const actions = (p: Player) =>\n    canManage && (");
    expect(roster).toContain('{canManage ? ` · ${ratingLabel(p.rating)} · Stamina ${Number(p.stamina)}/5` : ""}');
  });
  it("stamina is shown with its number (1–5), not as color alone", () => {
    expect(roster).toContain('<span className="sr-only"> of 5</span>');
    expect(read(`${G}/CanonicalPlayerForm.tsx`)).toContain("1 = lower endurance · 5 = higher endurance");
  });
});

describe("Groups page", () => {
  it("is Organization-scoped by the URL, membership-verified (generic 404) and uses real data", () => {
    expect(groupsPage).toContain("requireOrganizationContextForSlug({ organizationSlug })");
    expect(groupsPage).toContain("notFound();");
    expect(groupsPage).toContain("loadOrganizationGroups(context)");
  });
  it("Create Group only for the existing group-creator roles; Settings only for managers; sport is never editable here", () => {
    expect(groupsPage).toContain("hasOrgRole(context, [...GROUP_CREATOR_ROLES])");
    expect(groupsPage).toMatch(/\{canCreate && \(\s*<Link href=\{newHref\}/);
    expect(groupsPage).toMatch(/\{canManage && \(\s*<Link href=\{`\$\{g\.href\}#settings`\}/);
    expect(groupsPage).not.toMatch(/sportKey.*onChange|<select/);
    expect(read("src/app/admin/o/[organizationSlug]/groups/new/AddGroupForm.tsx")).toContain("Sport can&apos;t be changed later.");
  });
  it("visibility labels are the real enum values; no invented integrations", () => {
    expect(VISIBILITY_LABELS).toEqual({ PRIVATE: "Private", LINK: "Anyone with the link", PUBLIC: "Public" });
    expect(groupsPage).not.toMatch(/WhatsApp|billing|Billing|invite/i);
  });
  it.each([`${G}/players/PlayersRoster.tsx`, "src/app/admin/o/[organizationSlug]/groups/page.tsx", "src/lib/organizationGroups.ts", "src/lib/playerRoster.ts", "src/components/app/Dialog.tsx"])(
    "%s has no Lovable mock data / preview infrastructure",
    (f) => {
      expect(read(f)).not.toMatch(/usePreview|AppPreview|seedRoster|mock\.ts|Indoor Soccer|Saturday Basketball|Yasmina|Bahrom|localStorage|sessionStorage/);
    }
  );
});
