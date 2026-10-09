import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { AttendanceStatusButtons, attendanceButtonClass, type AttendanceStatus } from "@/components/game-day/AttendanceStatusButtons";
import { effectiveAttendance, type AttendanceRow } from "@/lib/attendance";

/**
 * M9.3 — organizer attendance buttons highlight the player's EFFECTIVE status
 * (server-computed: override, else the player's own answer from any source).
 */
const render = (effective: AttendanceStatus | null) =>
  renderToStaticMarkup(createElement(AttendanceStatusButtons, { playerName: "Bahrom M", effective, busy: false, onSet: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)].map((m) => ({ pressed: m[1] === "true", cls: m[2], inner: m[3] }));
const label = (inner: string) => inner.replace(/<svg[\s\S]*?<\/svg>/g, "");
const row = (r: Partial<AttendanceRow>): AttendanceRow => ({ playerId: "p", participantStatus: null, participantSource: null, participantRespondedAt: null, overrideStatus: null, overrideAt: null, ...r });

describe("organizer attendance buttons", () => {
  it.each([
    ["PLAYING", "Playing", "bg-primary"],
    ["MAYBE", "Maybe", "bg-accent"],
    ["NOT_PLAYING", "Not playing", "bg-destructive/10"],
  ] as const)("%s → only that button is selected (aria-pressed + check mark + its color)", (status, text, color) => {
    const b = buttons(render(status));
    expect(b.map((x) => label(x.inner))).toEqual(["Playing", "Maybe", "Not playing"]);
    const on = b.filter((x) => x.pressed);
    expect(on).toHaveLength(1);
    expect(label(on[0].inner)).toBe(text);
    expect(on[0].cls).toContain(color);
    expect(on[0].inner).toContain("<svg"); // not color alone
    for (const x of b.filter((y) => !y.pressed)) {
      expect(x.cls).toContain("bg-card");
      expect(x.inner).not.toContain("<svg");
    }
  });

  it("no response → all three neutral, none pressed, all clickable", () => {
    const html = render(null);
    const b = buttons(html);
    expect(b).toHaveLength(3);
    expect(b.every((x) => !x.pressed && x.cls.includes("bg-card") && !x.inner.includes("<svg"))).toBe(true);
    expect(html).not.toMatch(/\sdisabled=""/); // attribute (the class "disabled:opacity-50" is only a style)
    expect(html).toContain('aria-label="Set attendance for Bahrom M"');
  });

  it("colors: Playing green (primary), Maybe amber (accent), Not playing muted red; unselected neutral", () => {
    expect(attendanceButtonClass("PLAYING", "PLAYING")).toBe("border-primary bg-primary text-primary-foreground");
    expect(attendanceButtonClass("MAYBE", "MAYBE")).toBe("border-accent bg-accent text-accent-foreground");
    expect(attendanceButtonClass("NOT_PLAYING", "NOT_PLAYING")).toBe("border-destructive/50 bg-destructive/10 text-destructive");
    expect(attendanceButtonClass("PLAYING", "MAYBE")).toContain("bg-card");
    expect(attendanceButtonClass(null, "PLAYING")).toContain("bg-card");
  });

  it("follows the server's effective status: a Match Link answer, a change, and an organizer override", () => {
    const pressed = (r: AttendanceRow) => buttons(render(effectiveAttendance(r, null).status)).filter((x) => x.pressed).map((x) => label(x.inner));
    const t = new Date("2026-10-08T12:00:00Z");
    expect(pressed(row({ participantStatus: "PLAYING", participantSource: "LINK", participantRespondedAt: t }))).toEqual(["Playing"]);
    expect(pressed(row({ participantStatus: "MAYBE", participantSource: "LINK", participantRespondedAt: t }))).toEqual(["Maybe"]);
    expect(pressed(row({ participantStatus: "NOT_PLAYING", participantSource: "TELEGRAM", participantRespondedAt: t }))).toEqual(["Not playing"]);
    // Organizer override wins over the player's own answer.
    expect(pressed(row({ participantStatus: "PLAYING", participantSource: "LINK", participantRespondedAt: t, overrideStatus: "NOT_PLAYING", overrideAt: t }))).toEqual(["Not playing"]);
    expect(pressed(row({ overrideStatus: "MAYBE", overrideAt: t }))).toEqual(["Maybe"]);
    expect(pressed(row({}))).toEqual([]);
  });

  it("the Match Workspace passes the server's effective status (no client-only attendance state)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx"), "utf8");
    expect(src).toContain("effective={p.attendance.status}");
    expect(src).not.toContain("p.attendance.overridden && p.attendance.status === s");
  });
});
