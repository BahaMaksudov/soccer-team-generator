import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  formatTeamsHtml,
  splitTelegramText,
  formatMDYYFromDate,
  formatMDYYFromISO,
  formatYMDFromDate,
  parsePollDateFromQuestion,
  resolvePollDisplayDate,
  resolvePollCalendarDate,
  isPlayingVote,
} from "../telegramFormat";

describe("escapeHtml", () => {
  it("escapes &, <, > for Telegram HTML parse_mode", () => {
    expect(escapeHtml("Rock & Roll <script>")).toBe("Rock &amp; Roll &lt;script&gt;");
  });
});

describe("formatTeamsHtml", () => {
  it("includes every player's name and falls back to 'Unknown' for a blank name", () => {
    const html = formatTeamsHtml("1/19/26", [
      { teamNumber: 1, players: [{ firstName: "Ana", lastName: "Lee" }, { firstName: "", lastName: "" }] },
    ]);
    expect(html).toContain("Ana Lee");
    expect(html).toContain("Unknown");
    expect(html).toContain("Team #1");
    expect(html).toContain("1/19/26");
  });
});

describe("splitTelegramText", () => {
  it("does not split text under the limit", () => {
    expect(splitTelegramText("short", 100)).toEqual(["short"]);
  });

  it("splits long text on line boundaries without exceeding the max size", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const chunks = splitTelegramText(lines.join("\n"), 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });
});

describe("formatMDYYFromDate / formatMDYYFromISO", () => {
  it("formats a UTC date as M/D/YY with no leading zeros", () => {
    expect(formatMDYYFromDate(new Date("2026-01-19T00:00:00.000Z"))).toBe("1/19/26");
    expect(formatMDYYFromDate(new Date("2026-11-03T00:00:00.000Z"))).toBe("11/3/26");
  });

  it("formatMDYYFromISO matches formatMDYYFromDate for the same date-only string", () => {
    expect(formatMDYYFromISO("2026-01-19")).toBe("1/19/26");
  });
});

describe("parsePollDateFromQuestion (legacy fallback only)", () => {
  it("extracts an M/D/YY date from a well-formed auto-generated question", () => {
    expect(parsePollDateFromQuestion("Who is playing on 1/19/26?")).toBe("1/19/26");
  });

  it("returns null for a custom question override with no matching pattern", () => {
    expect(parsePollDateFromQuestion("Game night — bring cleats!")).toBeNull();
  });

  it("returns null for missing/empty input", () => {
    expect(parsePollDateFromQuestion(null)).toBeNull();
    expect(parsePollDateFromQuestion(undefined)).toBeNull();
    expect(parsePollDateFromQuestion("")).toBeNull();
  });
});

describe("resolvePollDisplayDate — REGRESSION: pollDate column is the source of truth", () => {
  it("prefers poll.pollDate over the question text, even when they disagree", () => {
    const poll = {
      pollDate: new Date("2026-02-02T00:00:00.000Z"),
      question: "Who is playing on 1/19/26?", // deliberately different/stale
    };
    expect(resolvePollDisplayDate(poll, "2026-03-03")).toBe("2/2/26");
  });

  it("falls back to parsing the question only when pollDate is null (legacy rows)", () => {
    const poll = { pollDate: null, question: "Who is playing on 1/19/26?" };
    expect(resolvePollDisplayDate(poll, "2026-03-03")).toBe("1/19/26");
  });

  it("does not break under a custom question override — falls back to the publish date instead of crashing", () => {
    const poll = { pollDate: null, question: "Game night — bring cleats!" };
    expect(resolvePollDisplayDate(poll, "2026-03-03")).toBe("3/3/26");
  });

  it("returns 'unknown date' when nothing is available", () => {
    expect(resolvePollDisplayDate(null, null)).toBe("unknown date");
  });
});

describe("formatYMDFromDate", () => {
  it("formats a UTC date as YYYY-MM-DD, zero-padded", () => {
    expect(formatYMDFromDate(new Date("2026-01-26T00:00:00.000Z"))).toBe("2026-01-26");
    expect(formatYMDFromDate(new Date("2026-11-03T00:00:00.000Z"))).toBe("2026-11-03");
  });

  it("never shifts the calendar day near a UTC day boundary", () => {
    // A timestamp at 23:59:59 UTC must still read as the same day —
    // this is the exact off-by-one shape the app has hit before.
    expect(formatYMDFromDate(new Date("2026-01-26T23:59:59.000Z"))).toBe("2026-01-26");
    expect(formatYMDFromDate(new Date("2026-01-26T00:00:00.001Z"))).toBe("2026-01-26");
  });

  it("does not shift across month or year boundaries", () => {
    expect(formatYMDFromDate(new Date("2026-01-31T00:00:00.000Z"))).toBe("2026-01-31");
    expect(formatYMDFromDate(new Date("2025-12-31T00:00:00.000Z"))).toBe("2025-12-31");
    expect(formatYMDFromDate(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-03-01");
  });
});

describe("resolvePollCalendarDate — REQUIRED CONTRACT", () => {
  it("a stored pollDate of 2026-01-26 produces pollDate='2026-01-26' AND pollDateStr='1/26/26'", () => {
    const poll = { pollDate: new Date("2026-01-26T00:00:00.000Z"), question: "Who is playing on 1/26/26?" };
    expect(resolvePollCalendarDate(poll)).toBe("2026-01-26");
    expect(resolvePollDisplayDate(poll, null)).toBe("1/26/26");
  });

  it("never turns January 26 into January 25 or January 27", () => {
    const poll = { pollDate: new Date("2026-01-26T00:00:00.000Z"), question: null };
    const ymd = resolvePollCalendarDate(poll);
    expect(ymd).not.toBe("2026-01-25");
    expect(ymd).not.toBe("2026-01-27");
    expect(ymd).toBe("2026-01-26");
  });

  it("prefers poll.pollDate over the question text, even when they disagree", () => {
    const poll = { pollDate: new Date("2026-02-02T00:00:00.000Z"), question: "Who is playing on 1/19/26?" };
    expect(resolvePollCalendarDate(poll)).toBe("2026-02-02");
  });

  it("falls back to parsing the question (converted to YYYY-MM-DD) only when pollDate is null", () => {
    const poll = { pollDate: null, question: "Who is playing on 1/19/26?" };
    expect(resolvePollCalendarDate(poll)).toBe("2026-01-19");
  });

  it("returns null — never today's date, never a guess — when nothing is available", () => {
    expect(resolvePollCalendarDate(null)).toBeNull();
    expect(resolvePollCalendarDate({ pollDate: null, question: "Game night — bring cleats!" })).toBeNull();
  });

  it("round-trips single-digit month/day correctly (e.g. 1/6/26 -> 2026-01-06)", () => {
    const poll = { pollDate: null, question: "Who is playing on 1/6/26?" };
    expect(resolvePollCalendarDate(poll)).toBe("2026-01-06");
  });

  it("protects month and year boundaries", () => {
    expect(resolvePollCalendarDate({ pollDate: new Date("2026-01-01T00:00:00.000Z") })).toBe("2026-01-01");
    expect(resolvePollCalendarDate({ pollDate: new Date("2025-12-31T00:00:00.000Z") })).toBe("2025-12-31");
  });
});

describe("isPlayingVote", () => {
  it("is true only when option index 0 ('Playing') is present", () => {
    expect(isPlayingVote("[0]")).toBe(true);
    expect(isPlayingVote("[0,1]")).toBe(true);
    expect(isPlayingVote("[1]")).toBe(false);
  });

  it("is false for malformed/empty JSON rather than throwing", () => {
    expect(isPlayingVote("")).toBe(false);
    expect(isPlayingVote("not json")).toBe(false);
    expect(isPlayingVote("{}")).toBe(false);
  });
});
