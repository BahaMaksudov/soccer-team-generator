import { describe, it, expect } from "vitest";
import { mapsUrl } from "@/lib/venues";
import { renderTelegramHtml } from "@/lib/messaging/telegram";
import { teamsContent } from "@/lib/messaging/content";
import { formatTeamsHtml } from "@/lib/telegramFormat";
import { contentHashOf } from "@/lib/messaging/deliveryState";

/** M9.2 — venue map links and the Telegram team-post location lines. */
const TEAMS = [{ teamNumber: 1, players: [{ firstName: "Ann", lastName: "One" }] }];

describe("mapsUrl", () => {
  it("keyless Google Maps search URL; the address is encoded (no injection into the URL)", () => {
    expect(mapsUrl("10 Pine Street, Norfolk, MA")).toBe("https://www.google.com/maps/search/?api=1&query=10%20Pine%20Street%2C%20Norfolk%2C%20MA");
    expect(mapsUrl('A&B "x" <y> #1 ?q=z')).toBe("https://www.google.com/maps/search/?api=1&query=A%26B%20%22x%22%20%3Cy%3E%20%231%20%3Fq%3Dz");
    expect(mapsUrl("  many   spaces\\n here ")).toBe("https://www.google.com/maps/search/?api=1&query=many%20spaces%5Cn%20here");
  });
  it("no address → no link (never a broken Location link)", () => {
    for (const a of [null, undefined, "", "   "]) expect(mapsUrl(a)).toBeNull();
  });
});

describe("Telegram team post with a venue", () => {
  const withVenue = (location: Parameters<typeof teamsContent>[0]["location"]) =>
    renderTelegramHtml(teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "10/12/26", teams: TEAMS, viewUrl: "https://tbp.test/m/1", location }));
  it("📍 Name, then 'Location:' as a clickable maps link, before the view link; everything escaped", () => {
    const html = withVenue({ name: "ForeKicks <Norfolk>", address: '10 Pine St "A&B"', mapsUrl: mapsUrl('10 Pine St "A&B"') });
    expect(html).toContain("📍 ForeKicks &lt;Norfolk&gt;");
    expect(html).toContain(`Location: <a href="https://www.google.com/maps/search/?api=1&amp;query=10%20Pine%20St%20%22A%26B%22">10 Pine St "A&amp;B"</a>`); // text: & < > escaped; attribute: quotes too
    expect(html.indexOf("📍")).toBeLessThan(html.indexOf("View teams online"));
  });
  it("a venue without an address shows its name only — no Location line", () => {
    const html = withVenue({ name: "Field 2", address: null, mapsUrl: null });
    expect(html).toContain("📍 Field 2");
    expect(html).not.toContain("Location:");
  });
  it("the delivery content hash never includes the venue (posted teams don't look 'updated')", () => {
    const body = formatTeamsHtml("10/12/26", TEAMS);
    expect(body).not.toContain("📍");
    expect(contentHashOf(body)).toBe(contentHashOf(formatTeamsHtml("10/12/26", TEAMS)));
  });
});
