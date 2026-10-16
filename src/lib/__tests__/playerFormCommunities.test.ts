import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CanonicalPlayerForm, { type PlayerFormCommunities } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalPlayerForm";
import { emptyPlayerForm } from "@/lib/canonicalAdminState";
import { findSport, sportClientView } from "@/lib/sports";

/** M9.2 — Community selection in the Add / Edit Player form (rendering only; the API is integration-tested). */
const sport = sportClientView(findSport("soccer")!);
const render = (communities?: PlayerFormCommunities) =>
  renderToStaticMarkup(createElement(CanonicalPlayerForm, { initial: emptyPlayerForm("MIDFIELDER"), sport, submitLabel: "Add player", busyLabel: "Adding…", onSubmit: async () => null, communities }));
const OPTIONS = [
  { id: "c-fc", name: "UCCNE - FC (Indoor Soccer)", isActive: true },
  { id: "c-wk", name: "Weekend League", isActive: true },
  { id: "c-old", name: "Old Tuesdays", isActive: false },
];

describe("player form: Communities", () => {
  it("not shown when the parent doesn't offer it (other workspaces unchanged)", () => {
    expect(render()).not.toContain("Communities");
  });
  it("multiple checkboxes for this Group's active Communities; the initial ones checked", () => {
    const html = render({ options: OPTIONS, initial: ["c-wk"], submit: "always" });
    expect(html).toContain("<legend");
    expect(html.match(/type="checkbox"/g)!.length).toBe(1 /* Active */ + 2);
    expect(html).toMatch(/checked=""[^>]*\/><span[^>]*>Weekend League/);
    expect(html).not.toContain("Old Tuesdays"); // inactive and not a member → not offered
  });
  it("a current membership in an inactive Community is shown (removable), never offered for new members", () => {
    const html = render({ options: OPTIONS, initial: ["c-old"], submit: "whenChanged" });
    expect(html).toContain("Old Tuesdays (inactive)");
  });
  it("a Group with no Communities: a short note with a link to create one; the form still works", () => {
    const html = render({ options: [], initial: [], submit: "always", settingsHref: "/admin/o/o/g/g/settings" });
    expect(html).toContain("This group has no communities yet.");
    expect(html).toContain('href="/admin/o/o/g/g/settings"');
    expect(html).toContain(">Add player</button>");
  });
});

describe("player form: memberships are saved only on submit", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const form = fs.readFileSync("src/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalPlayerForm.tsx", "utf8");
  const roster = fs.readFileSync("src/app/admin/o/[organizationSlug]/g/[groupSlug]/players/PlayersRoster.tsx", "utf8");
  it("ticking a checkbox only changes local form state (no request); the parent sends it with the form", () => {
    expect(form).not.toMatch(/fetch\(/);
    expect(form).toContain("onChange={(e) => setChosen(");
    expect(form).toContain('communities && (communities.submit === "always" || changed) ? chosen : undefined');
  });
  it("Edit sends communityIds only when the selection changed (unchanged → memberships untouched)", () => {
    expect(roster).toContain('submit: form.mode === "edit" ? "whenChanged" : "always"');
    expect(roster).toContain("...(communityIds !== undefined ? { communityIds } : {})");
  });
});
