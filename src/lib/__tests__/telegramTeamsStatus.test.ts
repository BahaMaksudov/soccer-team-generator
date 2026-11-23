import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { teamsTelegramStatus } from "@/lib/closeAndPostUi";

describe("teamsTelegramStatus — the workspace's Telegram line for published teams (server state only)", () => {
  it("maps every poll / delivery state", () => {
    expect(teamsTelegramStatus(null, null)).toEqual({ key: "no_poll", label: "Poll not posted" });
    expect(teamsTelegramStatus(null, "posted").key).toBe("no_poll"); // no poll of THIS match → never "posted"
    expect(teamsTelegramStatus({ closed: false }, null)).toEqual({ key: "ready", label: "Poll open — ready to close and post teams" });
    expect(teamsTelegramStatus({ closed: false }, "not_posted").key).toBe("ready");
    expect(teamsTelegramStatus({ closed: true }, "not_posted")).toEqual({ key: "poll_closed", label: "Poll closed — teams not posted yet" });
    expect(teamsTelegramStatus({ closed: true }, "posted")).toEqual({ key: "posted", label: "Teams posted" });
    expect(teamsTelegramStatus({ closed: true }, "updated_available")).toEqual({ key: "updated", label: "Teams changed — post updated teams" });
    expect(teamsTelegramStatus({ closed: false }, "sending").key).toBe("sending");
    expect(teamsTelegramStatus({ closed: false }, "failed").key).toBe("failed");
    expect(teamsTelegramStatus({ closed: false }, "uncertain").key).toBe("uncertain");
  });
});

describe("Match workspace — Telegram teams section wiring", () => {
  const src = fs.readFileSync("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx", "utf8");
  it("shows the status line and, without a poll, explains why and points at the existing Post-poll action", () => {
    expect(src).toContain('data-testid="teams-telegram-status"');
    expect(src).toContain("teamsTelegramStatus(view.telegram.poll, teamsDelivery)");
    expect(src).toContain('data-testid="teams-telegram-no-poll"');
    expect(src).toContain("document.getElementById(MATCH_TELEGRAM_GROUP_SELECTOR_ID)?.scrollIntoView(");
    // The other match's open poll is only reported — this page never sends anything for it.
    const note = src.slice(src.indexOf("view.telegram.otherOpenPoll && ("), src.indexOf("</p>", src.indexOf("view.telegram.otherOpenPoll && (")));
    expect(note).not.toMatch(/fetch\(|call\(|onClick/);
  });
  it("Post Teams is offered only for this match's own poll (unchanged)", () => {
    expect(src).toContain("(view.telegram.poll?.pollId ? (\n                <TeamsTelegramPost");
  });
  it("a canceled match with an open poll offers the existing Close Telegram poll", () => {
    expect(src).toContain('(view.telegram.closure?.teamsPosted || m.attendanceClosed || m.status === "CANCELED")');
  });
  it("same actions on every screen size (no device-specific logic)", () => {
    expect(src).not.toMatch(/innerWidth|matchMedia|navigator\.userAgent/);
  });
});
