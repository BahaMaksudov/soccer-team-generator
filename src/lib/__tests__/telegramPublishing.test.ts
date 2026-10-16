import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeAndPostFeedback, pollButtonView, pollCloseFeedback } from "@/lib/telegramPublishingUi";
import { pollPostStateOf } from "@/lib/attendancePollState";
import { pollClosedNoticeText } from "@/lib/pollClosure";
import { formatTeamsHtml, resolvePollDisplayDate } from "@/lib/telegramFormat";
import { renderTelegramHtml } from "@/lib/messaging/telegram";
import { teamsContent } from "@/lib/messaging/content";
import { teamBalanceProWebsiteUrl } from "@/lib/messaging/links";
import { MatchView } from "@/components/match-link/MatchView";
import type { PlayerMatchView } from "@/lib/matchPage";

/** Telegram publishing — pure pieces (no database, no network). */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("poll button: follows the PERSISTED state of the selected chat", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("state from the latest delivery record (hash = the current poll content)", () => {
    expect(pollPostStateOf(null, "h", now)).toBe("not_posted");
    expect(pollPostStateOf({ status: "SENDING", contentHash: "h", claimedAt: now }, "h", now)).toBe("posting");
    expect(pollPostStateOf({ status: "SENDING", contentHash: "h", claimedAt: new Date(now.getTime() - 3 * 60_000) }, "h", now)).toBe("uncertain");
    expect(pollPostStateOf({ status: "SENT", contentHash: "h", claimedAt: now }, "h", now)).toBe("posted");
    expect(pollPostStateOf({ status: "SENT", contentHash: "old", claimedAt: now }, "h", now)).toBe("details_changed");
    expect(pollPostStateOf({ status: "FAILED", contentHash: "h", claimedAt: now }, "h", now)).toBe("failed");
    expect(pollPostStateOf({ status: "UNCERTAIN", contentHash: "h", claimedAt: now }, "h", now)).toBe("uncertain");
  });
  it("labels and enablement — only not posted / failed can post", () => {
    const v = (state: Parameters<typeof pollButtonView>[0] extends infer P ? (P extends { state: infer S } ? S : never) : never) => pollButtonView({ state, at: null, otherChats: [] }, "FunnyStuff");
    expect(v("not_posted")).toMatchObject({ label: "Post poll to Telegram", enabled: true });
    expect(v("posting")).toMatchObject({ label: "Posting…", enabled: false });
    expect(v("posted")).toMatchObject({ label: "Poll posted", enabled: false, done: true });
    expect(v("failed")).toMatchObject({ label: "Retry posting", enabled: true, warn: true });
    expect(v("uncertain")).toMatchObject({ enabled: false, warn: true });
    expect(v("uncertain").note).toContain("Check FunnyStuff in Telegram");
    expect(v("details_changed")).toMatchObject({ label: "Poll details changed", enabled: false });
    expect(v("details_changed").note).toMatch(/explicit action/);
    expect(pollButtonView(null, null)).toMatchObject({ label: "Post poll to Telegram", enabled: true });
  });
});

describe("post-teams feedback: never claims a close that wasn't verified", () => {
  it("poll part", () => {
    expect(pollCloseFeedback("closed_now", "sent")).toBe("The attendance poll is closed. Closure notice sent.");
    expect(pollCloseFeedback("already_closed_locally", null)).toBe("The attendance poll was already closed.");
    for (const s of ["close_uncertain", "close_failed", "missing_message_id"] as const) {
      expect(pollCloseFeedback(s, null)).not.toMatch(/poll is closed\./);
      expect(pollCloseFeedback(s, null)).toContain("Close Telegram poll");
    }
    expect(pollCloseFeedback("close_uncertain", null)).toMatch(/may still be open/);
    expect(pollCloseFeedback("closed_now", "uncertain")).toMatch(/won't be sent again automatically/);
    expect(pollCloseFeedback("closed_now", "failed")).toMatch(/retry/);
  });
  it("partial success: teams posted but poll open; poll closed but teams not sent", () => {
    expect(closeAndPostFeedback(true, { status: "posted", closeStatus: "close_failed" })).toMatch(/^Teams posted to Telegram\. The attendance poll could NOT be closed/);
    expect(closeAndPostFeedback(false, { status: "telegram_rejected", closeStatus: "closed_now", noticeStatus: "sent" })).toBe(
      "The teams message was NOT sent (Telegram refused it) — you can retry. The attendance poll is closed. Closure notice sent."
    );
    expect(closeAndPostFeedback(false, { status: "delivery_unknown", closeStatus: "closed_now", noticeStatus: "sent" })).toMatch(/^Telegram didn't confirm the teams message/);
    expect(closeAndPostFeedback(true, { status: "already_posted", closeStatus: "already_closed_locally" })).toMatch(/nothing was sent again/);
  });
});

describe("the closure notice and the teams message footer", () => {
  it("historical notice text, M/D/YY from the poll date", () => {
    expect(pollClosedNoticeText(resolvePollDisplayDate({ pollDate: new Date("2026-09-23T00:00:00Z") }))).toBe("✅ Poll is closed for 9/23/26");
    expect(pollClosedNoticeText(resolvePollDisplayDate({ pollDate: new Date("2026-10-15T00:00:00Z") }))).toBe("✅ Poll is closed for 10/15/26");
  });
  const teams = [{ teamNumber: 1, players: [{ firstName: "Doni", lastName: "Alpha" }] }];
  const location = { name: "ForeKicks", address: "10 Pine St, Norfolk, MA", mapsUrl: "https://www.google.com/maps/search/?api=1&query=10%20Pine%20St" };
  it("footer: \"🔗 View teams online · 🌐 TeamBalance Pro\" after the venue + clickable address; teams unchanged", () => {
    const html = renderTelegramHtml(teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "10/15/26", teams, viewUrl: "https://teambalancepro.com/g/o/g/m/x", location, websiteUrl: "https://teambalancepro.com/" }));
    expect(html).toBe(
      [
        formatTeamsHtml("10/15/26", teams),
        "",
        "📍 ForeKicks",
        `Location: <a href="${location.mapsUrl.replaceAll("&", "&amp;")}">10 Pine St, Norfolk, MA</a>`,
        "",
        '<a href="https://teambalancepro.com/g/o/g/m/x">🔗 View teams online</a> · <a href="https://teambalancepro.com/">🌐 TeamBalance Pro</a>',
      ].join("\n")
    );
    // PRIVATE (no player-facing URL): only the website.
    expect(renderTelegramHtml(teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "10/15/26", teams, viewUrl: null, websiteUrl: "https://teambalancepro.com/" }))).toBe(
      `${formatTeamsHtml("10/15/26", teams)}\n\n<a href="https://teambalancepro.com/">🌐 TeamBalance Pro</a>`
    );
  });
  it("the content-hash body (formatTeamsHtml) is unchanged: already-posted teams never look 'updated'", () => {
    expect(formatTeamsHtml("10/15/26", teams)).toBe("<b>🏟️ Generated Teams — 10/15/26</b>\n\n<b>Team #1</b>\n• Doni Alpha");
  });
  it("website link = the existing APP_BASE_URL (https only; no new variable)", () => {
    expect(teamBalanceProWebsiteUrl({ APP_BASE_URL: "https://teambalancepro.com" })).toBe("https://teambalancepro.com/");
    expect(teamBalanceProWebsiteUrl({ APP_BASE_URL: "http://localhost:3000" })).toBeNull();
    expect(teamBalanceProWebsiteUrl({})).toBeNull();
    expect(read(".env.example")).not.toMatch(/WEBSITE_URL|TEAMBALANCE_URL/);
  });
});

describe("migration: one additive enum value", () => {
  const sql = read("prisma/migrations/20261020120000_poll_closed_notice/migration.sql").replace(/--.*$/gm, "").trim();
  it("adds ONLY 'POLL_CLOSED_NOTICE' (idempotent) — no table, column, index, row or data change", () => {
    expect(sql).toBe(`ALTER TYPE "MessageEventType" ADD VALUE IF NOT EXISTS 'POLL_CLOSED_NOTICE';`);
  });
});

describe("public Match page (\"View teams online\"): the shared redesigned player view", () => {
  const view: PlayerMatchView = {
    group: { name: "Indoor Soccer", teamName: "UCCNE FC", organizationName: "UCCNE", sportLabel: "Soccer" },
    match: { date: "2026-10-15", startTime: "21:00", locationName: "ForeKicks", status: "SCHEDULED" },
    venue: { name: "ForeKicks", address: "10 Pine St", mapsUrl: "https://www.google.com/maps/search/?api=1&query=10%20Pine%20St" },
    teamsPublished: true,
    teams: [
      { teamNumber: 1, players: [{ name: "Doni Alpha", role: "Goalkeeper" }] },
      { teamNumber: 2, players: [{ name: "Eli Beta", role: "Defender" }] },
    ],
    result: null,
    mvp: null,
    recap: null,
  };
  const html = renderToStaticMarkup(createElement(MatchView, { view, title: "UCCNE FC", subtitle: "UCCNE" }));
  it("organization branding, date, time, venue + map, team names and positions", () => {
    for (const s of ["UCCNE FC", "UCCNE", "Thursday, October 15, 2026", "9:00 PM", "ForeKicks", "10 Pine St", "View map", "Team 1", "Doni Alpha", "Goalkeeper", "Eli Beta", "Defender"]) expect(html).toContain(s);
  });
  it("mobile-first layout (single column, two columns from sm), no ratings or admin controls", () => {
    expect(html).toContain("sm:grid-cols-2");
    expect(html).not.toMatch(/rating|stamina|EXCELLENT|Edit|Delete|Publish/i);
  });
  it("the page reuses the shared view at the SAME URL (old links keep working); the old card is no longer rendered", () => {
    const page = read("src/app/g/[organizationSlug]/[groupSlug]/m/[matchId]/page.tsx");
    expect(page).toContain('import { MatchPageShell, MatchView } from "@/components/match-link/MatchView"');
    expect(page).not.toContain("PlayerMatchCard");
    expect(page).toContain("loadMatchForViewer"); // same access rules as before
    expect(read("src/components/match-link/MatchLinkPage.tsx")).toContain("<MatchView"); // one teams UI for both pages
  });
});
