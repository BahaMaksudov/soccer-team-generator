import { describe, it, expect } from "vitest";
import { formatTeamsHtml } from "@/lib/telegramFormat";
import { pollContent, renderTelegramHtml, renderTelegramPoll, teamsContent, playerFacingViewUrl, POLL_OPTIONS } from "@/lib/messaging";
import { isPlayingVote } from "@/lib/telegramFormat";

// Verbatim copy of the pre-M6 formatter, kept only as the equivalence oracle.
function legacyEscapeHtml(s: string): string {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function legacyFormatTeamsHtml(
  displayDate: string,
  teams: Array<{ teamNumber: number; players: Array<{ firstName?: string | null; lastName?: string | null }> }>
): string {
  const title = `<b>\u{1F3DF}\u{FE0F} Generated Teams — ${legacyEscapeHtml(displayDate)}</b>`;
  const lines: string[] = [title, ""];
  for (const t of teams) {
    lines.push(`<b>Team #${legacyEscapeHtml(String(t.teamNumber))}</b>`);
    const players = Array.isArray(t.players) ? t.players : [];
    for (const p of players) {
      const first = (p?.firstName ?? "").toString().trim();
      const last = (p?.lastName ?? "").toString().trim();
      const name = `${first} ${last}`.trim() || "Unknown";
      lines.push(`• ${legacyEscapeHtml(name)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

const CASES: Array<[string, Parameters<typeof legacyFormatTeamsHtml>[1]]> = [
  ["10/5/26", [
    { teamNumber: 1, players: [{ firstName: "Doni", lastName: "Alpha" }, { firstName: "Eli", lastName: null }] },
    { teamNumber: 2, players: [{ firstName: " ", lastName: "" }, { firstName: "A&B <x>", lastName: "O'Neil" }] },
  ]],
  ["<b>bad</b> & date", [{ teamNumber: 3, players: [] }]],
  ["1/19/26", []],
  ["9/23/26", [{ teamNumber: 1, players: [{}, { firstName: "Ünïcode", lastName: "名前" }] }]],
];

describe("Telegram teams message — byte-identical to the pre-M6 formatter", () => {
  it.each(CASES)("date %s", (date, teams) => {
    expect(formatTeamsHtml(date, teams)).toBe(legacyFormatTeamsHtml(date, teams));
  });

  it("no link is added unless a viewUrl is supplied", () => {
    expect(formatTeamsHtml("10/5/26", CASES[0][1])).not.toContain("<a ");
  });
});

describe("TEAMS_PUBLISHED with a player-facing link", () => {
  it("appends an escaped link after the teams", () => {
    const html = renderTelegramHtml(
      teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "10/5/26", teams: CASES[0][1], viewUrl: 'https://teambalancepro.com/g/a/b?x="1"&y=2' })
    );
    expect(html.startsWith(legacyFormatTeamsHtml("10/5/26", CASES[0][1]))).toBe(true);
    expect(html.endsWith('\n\n<a href="https://teambalancepro.com/g/a/b?x=&quot;1&quot;&amp;y=2">View teams online</a>')).toBe(true);
  });
});

describe("POLL_CREATED", () => {
  it("default question and options match the pre-M6 poll exactly", () => {
    expect(renderTelegramPoll(pollContent({ type: "POLL_CREATED", pollDate: "2026-10-05" }))).toEqual({
      question: "Who is playing on 10/5/26?",
      options: ["✅ Playing", "❌ Not playing"],
      is_anonymous: false,
      allows_multiple_answers: false,
    });
  });
  it("a custom question is trimmed; blank falls back to the default", () => {
    expect(pollContent({ type: "POLL_CREATED", pollDate: "2026-01-09", customQuestion: "  Monday? " }).question).toBe("Monday?");
    expect(pollContent({ type: "POLL_CREATED", pollDate: "2026-01-09", customQuestion: "   " }).question).toBe("Who is playing on 1/9/26?");
  });
  it("option 0 is the 'playing' option that import counts", () => {
    expect(POLL_OPTIONS[0]).toBe("✅ Playing");
    expect(isPlayingVote("[0]")).toBe(true);
    expect(isPlayingVote("[1]")).toBe(false);
  });
});

describe("playerFacingViewUrl — which URL a message may carry", () => {
  const env = { NODE_ENV: "production", APP_BASE_URL: "https://teambalancepro.com" };
  const base = { organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer", env };
  const share = "https://teambalancepro.com/share#" + "A".repeat(43);

  it("PUBLIC → canonical Group page on APP_BASE_URL", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "PUBLIC" })).toBe("https://teambalancepro.com/g/new-england-eagles/indoor-soccer");
  });
  it("LINK → only a supplied share URL on APP_BASE_URL", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", shareUrl: share })).toBe(share);
    expect(playerFacingViewUrl({ ...base, visibility: "LINK" })).toBeNull();
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", shareUrl: "https://evil.example/share#x" })).toBeNull();
    expect(playerFacingViewUrl({ ...base, visibility: "LINK", shareUrl: "https://teambalancepro.com/share#" })).toBeNull();
  });
  it("PRIVATE → never a URL, even if one is supplied", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "PRIVATE", shareUrl: share })).toBeNull();
  });
  it("missing/invalid APP_BASE_URL → no link (message still sendable)", () => {
    expect(playerFacingViewUrl({ ...base, visibility: "PUBLIC", env: { NODE_ENV: "production" } })).toBeNull();
    expect(playerFacingViewUrl({ ...base, visibility: "PUBLIC", env: { NODE_ENV: "production", APP_BASE_URL: "http://teambalancepro.com" } })).toBeNull();
  });
});
