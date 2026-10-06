import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import PostGameSection, { type PostGameView } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection";

/**
 * UI-4A — MEMBER sees organizer surfaces read-only: organizer mutation
 * controls are not rendered (not merely disabled). PRESENTATION ONLY — the
 * server rejects every one of these mutations for MEMBER on its own
 * (src/integration/organizerAuthz.itest.ts).
 */
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const G = "src/app/admin/o/[organizationSlug]/g/[groupSlug]";

const pg = (over: Partial<PostGameView> = {}): PostGameView => ({
  canceled: false,
  teamNumbers: [1, 2],
  participants: [
    { playerId: "a", name: "Ann One", teamNumber: 1 },
    { playerId: "b", name: "Bo Two", teamNumber: 2 },
  ],
  result: { scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 2 }], published: true },
  mvp: null,
  mvpMaxCandidates: 10,
  recap: { content: "A tight game.", source: "DETERMINISTIC", published: false, hasAiDraft: false },
  standardRecap: "Standard recap.",
  aiConfigured: false,
  messages: null,
  ...over,
});
const render = (canManage: boolean, view = pg()) =>
  renderToStaticMarkup(createElement(PostGameSection, { pg: view, canManage, busy: false, act: vi.fn(), request: vi.fn(), notify: vi.fn() }));

describe("post-game section", () => {
  it("MEMBER: read-only state and content — no buttons, inputs, editors or send", () => {
    const html = render(false);
    expect(html).not.toMatch(/<button|<input|<textarea|<select/);
    expect(html).not.toMatch(/Save Result|Publish Result|Publish Recap|Save Recap|Player Vote|Organizer Selection|Post Match Summary/);
    expect(html).toContain("A tight game.");
    expect(html).toContain("An owner or admin posts the match summary to Telegram.");
    for (const id of ["result", "mvp", "recap", "summary"]) expect(html).toContain(`id="${id}"`);
  });
  it("OWNER/ADMIN: the approved UI-4 editors are unchanged", () => {
    const html = render(true, pg({ result: { scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 2 }], published: false } }));
    expect(html).toMatch(/Save Result|Save Changes/); // (Publish appears once the saved scores load client-side)
    expect(html).toMatch(/<input[^>]*type="number"/);
    expect(html).toMatch(/<textarea/);
    expect(html).toContain("Save Recap");
  });
});

describe("source gating (organizer controls exist only inside manager branches)", () => {
  const ws = read(`${G}/matches/[matchId]/MatchWorkspace.tsx`);
  it("Match workspace: match management, attendance management and team generation are canManage-only", () => {
    const managed = (marker: string) => {
      const i = ws.indexOf(marker);
      expect(i, marker).toBeGreaterThan(-1);
      return ws.lastIndexOf("view.canManage", i) > -1 && ws.lastIndexOf("view.canManage", i) > ws.lastIndexOf("return (", i);
    };
    for (const marker of ["Mark completed", "Cancel match", 'm.attendanceClosed ? "Reopen attendance" : "Close attendance"', "Sync Telegram attendance", "Set attendance for", "<CanonicalGenerateSection", "Post poll to Telegram"])
      expect(managed(marker), marker).toBe(true);
    expect(ws).toContain("<PublishedTeams teams={view.generation.teams}");
    // "Clear override" lives inside the canManage-gated "Set attendance for …" group.
    const group = ws.slice(ws.indexOf("<div role=\"group\" aria-label={`Set attendance for"));
    expect(group.indexOf("Clear override")).toBeGreaterThan(0);
    expect(group.indexOf("Clear override")).toBeLessThan(group.indexOf("</li>"));
  });
  it("Post-game: MEMBER gets PostGameReadOnly", () => {
    expect(read(`${G}/matches/[matchId]/PostGameSection.tsx`)).toContain("if (!canManage) return <PostGameReadOnly pg={pg} />;");
  });
  it("Matches page: New match only for managers; Overview: New/Create match and Needs attention only for managers", () => {
    expect(read(`${G}/matches/page.tsx`)).toContain("{isManager(context) && <CreateMatchForm");
    const overview = read(`${G}/page.tsx`);
    expect(overview).toMatch(/overview\.canManage && \(\s*<ActionLink href=\{`\$\{matchesHref\}#new`\}/);
    expect(overview).toContain("hasMatches && overview.canManage && <NeedsAttention");
    expect(overview).toMatch(/if \(!canManage\)\s*return \(/); // read-only empty state without Create match
  });
  it("Group page: generation, settings and sharing are manager-only; the roster is read-only for MEMBER", () => {
    const wsGroup = read(`${G}/CanonicalAdminWorkspace.tsx`);
    expect(wsGroup).toMatch(/\{canManage && \(\s*<>\s*<CanonicalGenerateSection/);
    const players = read(`${G}/CanonicalPlayersSection.tsx`);
    for (const marker of ["submitLabel=\"Add player\"", "onClick={() => toggleActive(p)}", "onClick={() => setEditing(p)}", "onClick={() => setConfirmDeleteId(p.id)}", "<PlayerAccountCell", "onChange={() => onToggleSelected(p.id)}"]) {
      const i = players.indexOf(marker);
      expect(i, marker).toBeGreaterThan(-1);
      expect(players.lastIndexOf("canManage", i), marker).toBeGreaterThan(players.lastIndexOf("<tr", i) - 2000);
    }
  });
});
