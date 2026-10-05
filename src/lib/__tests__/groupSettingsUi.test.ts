import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { adminGroupPath, adminGroupSettingsPath } from "@/lib/matchPaths";

/**
 * UI-8 — the Overview no longer embeds the legacy "Players & group
 * settings" workspace; every capability has ONE redesigned home:
 * Players → /players, match-day attendance / Telegram poll / teams /
 * post-game → the Match Workspace, group configuration → /settings.
 */
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const G = "src/app/admin/o/[organizationSlug]/g/[groupSlug]";
const overview = read(`${G}/page.tsx`);
const settingsPage = read(`${G}/settings/page.tsx`);
const settings = read(`${G}/settings/GroupSettings.tsx`);
const voterLinks = read(`${G}/settings/TelegramVoterLinks.tsx`);
const workspace = read(`${G}/matches/[matchId]/MatchWorkspace.tsx`);
const groupsPage = read("src/app/admin/o/[organizationSlug]/groups/page.tsx");

const listFiles = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

describe("Overview ends after the dashboard", () => {
  it("renders no legacy workspace or any of its sections", () => {
    expect(overview).not.toMatch(/CanonicalAdminWorkspace|CanonicalPlayersSection|CanonicalGenerateSection|CanonicalSettingsSection|CanonicalVisibilitySection|CanonicalTelegramSection|CommunicationChannelsSection/);
    expect(overview).not.toContain("Players &amp; group settings");
    expect(overview).not.toContain('id="group-management"');
  });
  it("links to Players and Matches for everyone, and to Group settings for managers only", () => {
    expect(overview).toContain("adminGroupPath(context.organization.slug, context.activeGroup.slug)}/players`");
    expect(overview).toContain("href={matchesHref}");
    expect(overview).toMatch(/\{overview\.canManage && \(\s*<Link href=\{adminGroupSettingsPath\(context\.organization\.slug, context\.activeGroup\.slug\)\}/);
  });
  it("no page under the redesigned app mounts the legacy workspace / legacy Telegram section", () => {
    const offenders = listFiles("src/app")
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /<CanonicalAdminWorkspace\b|<CanonicalTelegramSection\b|<CanonicalPlayersSection\b/.test(read(f)))
      .filter((f) => !f.endsWith("CanonicalAdminWorkspace.tsx"));
    expect(offenders).toEqual([]);
  });
});

describe("Group settings — the one location for group-level configuration", () => {
  it("path", () => {
    expect(adminGroupSettingsPath("o x", "g")).toBe(`${adminGroupPath("o x", "g")}/settings`);
    expect(adminGroupSettingsPath("o", "g")).toBe("/admin/o/o/g/g/settings");
  });
  it("OWNER/ADMIN only: URL-resolved context, generic 404 for MEMBER / foreign / unknown", () => {
    expect(settingsPage).toContain("loadCanonicalAdminContext(await params)");
    expect(settingsPage).toContain("if (!context || !isManager(context)) notFound();");
  });
  it("hosts team name + balance weights, visibility/share link, Telegram connection and voter links", () => {
    for (const s of ["<CanonicalSettingsSection", "<CanonicalVisibilitySection", "<CommunicationChannelsSection", "<TelegramVoterLinks"]) expect(settings).toContain(s);
    expect(voterLinks).toContain('path: "/telegram/users"');
    expect(voterLinks).toContain('path: "/telegram/link"');
  });
  it("configuration only — no match-day Telegram operations", () => {
    for (const src of [settings, voterLinks]) expect(src).not.toMatch(/create-poll|close-and-post|\/telegram\/import|\/attendance|\/poll"|\/generate|\/publish/);
  });
  it("the Groups page Settings action and the Match Workspace hints point here", () => {
    expect(groupsPage).toContain("<Link href={`${g.href}/settings`}");
    expect(groupsPage).not.toContain("#settings");
    expect(workspace.match(/adminGroupSettingsPath\(organizationSlug, groupSlug\)\}#telegram/g)).toHaveLength(2);
    expect(workspace).not.toContain("on the group page");
  });
});

describe("Match Workspace remains the organizer's match-day Telegram path", () => {
  it("attendance poll → sync → close attendance → generate → publish → post teams", () => {
    for (const s of ['call("/poll", { chatRef, intent: "post" }', 'call("/attendance/sync"', 'call("/attendance/close"', "<CanonicalGenerateSection", 'path: "/telegram/close-and-post"', "Post Teams to Telegram"]) expect(workspace).toContain(s);
  });
});
