import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import MyAttendance from "@/app/me/MyAttendance";

/**
 * UI-4B — closed attendance is presented READ-ONLY (controls are not rendered,
 * not just disabled) and the controls return after reopening. Presentation
 * only: the server rejects every attendance change while closed
 * (src/integration/closedAttendance.itest.ts).
 */
const ws = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx"), "utf8");

describe("organizer Match workspace (OWNER/ADMIN)", () => {
  it("per-player Playing / Maybe / Not playing / Clear override render only while attendance is OPEN", () => {
    // M9.3 — the three buttons are the AttendanceStatusButtons component ("Set attendance for …" group).
    const gate = ws.indexOf("{!m.attendanceClosed && (\n              <div className=\"flex flex-wrap items-center gap-1\">");
    expect(gate).toBeGreaterThan(-1);
    const block = ws.slice(gate, ws.indexOf("</li>", gate));
    for (const marker of ["<AttendanceStatusButtons", 'call("/attendance", { playerId: p.id, status: s }', 'call("/attendance", { playerId: p.id, status: null }', "Clear override"]) expect(block, marker).toContain(marker);
    // no other attendance-mutation call exists outside that gate
    expect(ws.split('call("/attendance", {').length - 1).toBe(2);
  });
  it("closed: explanation shown; Reopen attendance stays available; Telegram sync hidden until reopened", () => {
    expect(ws).toContain("Attendance is closed. Reopen attendance to make changes.");
    expect(ws).toContain('{m.attendanceClosed ? "Reopen attendance" : "Close attendance"}');
    expect(ws).toMatch(/view\.canManage && !m\.attendanceClosed && view\.telegram\.poll && \([\s\S]{0,400}Sync Telegram attendance/);
  });
});

describe("player self-attendance (/me)", () => {
  const html = (closed: boolean, status: "PLAYING" | "MAYBE" | "NOT_PLAYING" | null = "PLAYING") =>
    renderToStaticMarkup(createElement(MyAttendance, { matchId: "m1", status, byOrganizer: false, closed }));
  it("OPEN: the three answer buttons", () => {
    const h = html(false);
    expect(h.match(/<button/g)).toHaveLength(3);
    for (const l of ["Playing", "Maybe", "Not playing"]) expect(h).toContain(`>${l}</button>`);
  });
  it("CLOSED: read-only answer + explanation, no buttons", () => {
    const h = html(true, "MAYBE");
    expect(h).not.toContain("<button");
    expect(h).toContain("Your answer: <span");
    expect(h).toContain(">Maybe</span>");
    expect(h).toContain("Attendance is closed. Your organizer can reopen it.");
    expect(html(true, null)).toContain("No answer");
  });
});
