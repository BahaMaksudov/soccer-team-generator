import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { attendanceFromTelegramOptions, countAttendance, defaultSelection, effectiveAttendance, type AttendanceRow } from "@/lib/attendance";
import { BIND_CODE_TTL_MS, generateBindCode, isBindCode } from "@/lib/telegramChannels";
import { generateConnectCode, isWellFormedConnectCode } from "@/lib/telegramConnect";
import { ATTENDANCE_POLL_OPTIONS, POLL_OPTIONS, attendancePollContent, formatStartTime } from "@/lib/messaging";

const T0 = new Date("2026-10-07T12:00:00Z");
const later = (min: number) => new Date(T0.getTime() + min * 60_000);
const row = (over: Partial<AttendanceRow> = {}): AttendanceRow => ({
  playerId: "p1",
  participantStatus: null,
  participantSource: null,
  participantRespondedAt: null,
  overrideStatus: null,
  overrideAt: null,
  ...over,
});

describe("effective attendance (one precedence rule)", () => {
  it("no row / no answer → no response", () => {
    expect(effectiveAttendance(undefined, null)).toEqual({ status: null, source: null, overridden: false, late: false });
    expect(effectiveAttendance(row(), null).status).toBeNull();
  });
  it("participant answer applies when there is no override", () => {
    for (const s of ["PLAYING", "MAYBE", "NOT_PLAYING"] as const) {
      expect(effectiveAttendance(row({ participantStatus: s, participantSource: "TELEGRAM", participantRespondedAt: T0 }), null)).toEqual({ status: s, source: "TELEGRAM", overridden: false, late: false });
    }
  });
  it("organizer override wins and stays authoritative over a later participant answer", () => {
    const r = row({ participantStatus: "MAYBE", participantSource: "TELEGRAM", participantRespondedAt: later(10), overrideStatus: "PLAYING", overrideAt: T0 });
    expect(effectiveAttendance(r, null)).toEqual({ status: "PLAYING", source: "OVERRIDE", overridden: true, late: false });
  });
  it("clearing the override restores the participant's own answer", () => {
    const r = row({ participantStatus: "MAYBE", participantSource: "WEB", participantRespondedAt: T0 });
    expect(effectiveAttendance(r, null)).toMatchObject({ status: "MAYBE", source: "WEB", overridden: false });
  });
  it("answers after attendance closed are recorded but flagged late", () => {
    const r = row({ participantStatus: "PLAYING", participantSource: "TELEGRAM", participantRespondedAt: later(5) });
    expect(effectiveAttendance(r, T0).late).toBe(true);
    expect(effectiveAttendance(row({ participantStatus: "PLAYING", participantRespondedAt: later(-5) }), T0).late).toBe(false);
  });
  it("counts and default selection: MAYBE is never preselected; inactive players excluded", () => {
    const rows = [
      row({ playerId: "a", participantStatus: "PLAYING" }),
      row({ playerId: "b", participantStatus: "MAYBE" }),
      row({ playerId: "c", participantStatus: "NOT_PLAYING" }),
      row({ playerId: "d", participantStatus: "MAYBE", overrideStatus: "PLAYING" }),
      row({ playerId: "x", participantStatus: "PLAYING" }),
    ];
    expect(countAttendance(["a", "b", "c", "d", "e"], rows, null)).toEqual({ PLAYING: 2, MAYBE: 1, NOT_PLAYING: 1, NO_RESPONSE: 1 });
    const players = ["a", "b", "c", "d", "e"].map((id) => ({ id, isActive: true })).concat({ id: "x", isActive: false });
    expect(defaultSelection(players, rows, null)).toEqual(["a", "d"]);
  });
});

describe("Telegram attendance options", () => {
  it("✅/❌/🤔 map to PLAYING/NOT_PLAYING/MAYBE; legacy two-option indexes unchanged; retraction is null", () => {
    expect(ATTENDANCE_POLL_OPTIONS).toEqual([...POLL_OPTIONS, "🤔 Maybe"]);
    expect(POLL_OPTIONS).toEqual(["✅ Playing", "❌ Not playing"]);
    expect([[0], [1], [2], [], [9], "x", null].map(attendanceFromTelegramOptions)).toEqual(["PLAYING", "NOT_PLAYING", "MAYBE", null, null, null, null]);
  });
  it("poll content: date, optional time and location; within Telegram's 300-character question limit", () => {
    expect(attendancePollContent({ date: "2026-10-07", startTime: "20:00", locationName: "Fore Kicks Norfolk" })).toEqual({
      kind: "poll",
      question: "Who is playing on 10/7/26 at 8:00 PM — Fore Kicks Norfolk?",
      options: ["✅ Playing", "❌ Not playing", "🤔 Maybe"],
    });
    expect(attendancePollContent({ date: "2026-10-07" }).question).toBe("Who is playing on 10/7/26?");
    expect(attendancePollContent({ date: "2026-10-07", locationName: "x".repeat(400) }).question.length).toBeLessThanOrEqual(300);
    expect(["00:05", "12:00", "23:59", "bad"].map(formatStartTime)).toEqual(["12:05 AM", "12:00 PM", "11:59 PM", null]);
  });
});

describe("Telegram bind codes", () => {
  it("are namespaced g_, 128-bit, valid deep-link payloads (≤64 of A-Za-z0-9_-), 15-minute TTL", () => {
    const code = generateBindCode();
    expect(code).toMatch(/^g_[A-Za-z0-9_-]{22}$/);
    expect(code.length).toBeLessThanOrEqual(64);
    expect(isBindCode(code)).toBe(true);
    expect(BIND_CODE_TTL_MS).toBe(15 * 60 * 1000);
    expect(new Set(Array.from({ length: 200 }, generateBindCode)).size).toBe(200);
  });
  it("never collide with player connect codes (separate namespaces)", () => {
    const player = generateConnectCode();
    expect(isBindCode(player)).toBe(false);
    expect(isWellFormedConnectCode(generateBindCode())).toBe(false);
    for (const bad of ["g_short", "G_" + "a".repeat(22), "", null, 5]) expect(isBindCode(bad)).toBe(false);
  });
});

describe("Publish != Send — no-send services never import external send code", () => {
  const root = process.cwd();
  const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const NO_SEND = ["src/lib/generateTeams.ts", "src/lib/applySwap.ts", "src/lib/publishTeams.ts", "src/lib/matches.ts", "src/lib/attendance.ts", "src/lib/balanceAnalysis.ts"];
  it.each(NO_SEND)("%s imports no Telegram client/post code and calls no fetch", (f) => {
    const src = code(f);
    expect(src).not.toMatch(/telegramApi|callTelegram|telegramCloseAndPost|telegramAttendance|telegramChannels|sendMessage|sendPoll|fetch\(/);
  });
  it("the only M9-A sends are explicit post/bind actions", () => {
    const attendance = code("src/lib/telegramAttendance.ts");
    expect(attendance.match(/callTelegram\(/g)).toHaveLength(1); // postAttendancePoll only
    expect(attendance.slice(attendance.indexOf("export async function syncTelegramAttendance"), attendance.indexOf("export async function postAttendancePoll"))).not.toContain("callTelegram");
    const channels = code("src/lib/telegramChannels.ts");
    expect(channels.match(/callTelegram\(/g)).toHaveLength(1); // getChatAdministrators (read) during redeem
    expect(channels).not.toMatch(/sendMessage|sendPoll/);
  });
});

describe("public/player-facing privacy", () => {
  it("the public players API selects no internal id", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/public/[organizationSlug]/[groupSlug]/players/route.ts"), "utf8");
    const select = src.slice(src.indexOf("select: {"), src.indexOf("},", src.indexOf("select: {")));
    expect(select).not.toMatch(/\bid: true/);
  });
});
