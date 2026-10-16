import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildGameDayUpdate, DISCLAIMER_FIRST_LINE, TELEGRAM_TEXT_LIMIT, timeLeftText, type GameDayUpdateInput, type GameDayWeather } from "@/lib/messaging/gameDayUpdate";
import { WEATHER_ATTRIBUTION, WEATHER_DISCLAIMER } from "@/lib/weatherLegal";

/** Phase 4B step 5 — the pure Game Day Update message builder (no DB, no network, no clock). */
const TZ = "America/New_York";
/** A forecast as the provider adapter returns it: always with the linked attribution and the full disclaimer. */
const W = (w: GameDayWeather): GameDayWeather => ({ attributionLink: WEATHER_ATTRIBUTION, disclaimer: WEATHER_DISCLAIMER, ...w });
const LEGAL = [
  '<i>Powered by <a href="https://www.weatherapi.com/">WeatherAPI.com</a></i>',
  `<blockquote expandable>${DISCLAIMER_FIRST_LINE}\n${WEATHER_DISCLAIMER}</blockquote>`,
];
const SUMMARY = ["👥 Attendance Summary (27 players)", "✅ Playing: 14", "❌ Not Playing: 2", "🤔 Maybe: 3", "⏳ Not Responded: 8"];
// Monday, October 19, 2026 — kickoff 21:00 EDT; deadline 17:00 EDT; built at 13:00 EDT (4 h before).
const base = (over: Partial<GameDayUpdateInput> = {}): GameDayUpdateInput => ({
  groupName: "Indoor Soccer",
  displayName: null,
  timezone: TZ,
  match: { date: "2026-10-19", startTime: "21:00", venueName: "ForeKicks", isIndoor: false },
  deadline: new Date("2026-10-19T21:00:00Z"),
  attendance: { playing: 14, notPlaying: 2, maybe: 3, noResponse: 8 },
  link: null,
  weather: W({ temperatureC: 14.4, condition: "Cloudy", rainChancePercent: 25 }),
  units: "imperial",
  now: new Date("2026-10-19T17:00:00Z"),
  ...over,
});
const html = (over: Partial<GameDayUpdateInput> = {}) => {
  const r = buildGameDayUpdate(base(over));
  if (!r.ok) throw new Error(`expected a message, got ${r.reason}`);
  return r.html;
};

describe("the message", () => {
  it("matches the approved layout (Telegram HTML, parse_mode HTML, link previews off)", () => {
    const r = buildGameDayUpdate(base());
    expect(r).toMatchObject({ ok: true, parseMode: "HTML", disableWebPagePreview: true, truncated: false });
    expect(r.ok && r.html).toBe(
      [
        "<b>⚽ Game Day Update — Indoor Soccer</b>",
        "",
        "📅 Monday, October 19 · 9:00 PM EDT",
        "📍 ForeKicks",
        "🌤 Outside at kickoff: 58°F, cloudy",
        "🌧 Rain: 25%",
        ...LEGAL,
        "",
        ...SUMMARY,
        "",
        "⏰ Attendance closes in 4 hours (5:00 PM EDT).",
        "",
        "Please confirm or update your attendance before the deadline.",
      ].join("\n")
    );
  });

  it("manual and recurring matches use the same format (the builder takes no match type)", () => {
    const manual = html({ match: { date: "2026-10-21", startTime: "19:30", venueName: "Field 2" } });
    const recurring = html({ match: { date: "2026-10-19", startTime: "21:00", venueName: "ForeKicks" } });
    for (const m of [manual, recurring]) expect(m).toMatch(/^<b>⚽ Game Day Update — Indoor Soccer<\/b>\n\n📅 .+\n📍 .+\n/);
    expect(manual).toContain("📅 Wednesday, October 21 · 7:30 PM EDT");
  });

  it("the public display name is preferred when set (blank falls back to the group name)", () => {
    expect(html({ displayName: "New England Eagles" })).toContain("<b>⚽ Game Day Update — New England Eagles</b>");
    expect(html({ displayName: "   " })).toContain("<b>⚽ Game Day Update — Indoor Soccer</b>");
  });

  it("venue missing → no 📍 line; no start time → date only", () => {
    const h = html({ match: { date: "2026-10-19", startTime: null, venueName: null } });
    expect(h).not.toContain("📍");
    expect(h).toContain("📅 Monday, October 19\n");
    expect(h).not.toMatch(/\n\n\n/); // never empty lines left behind
  });

  it("attendance summary: all four counts and the roster total they add up to; singular; bad numbers → 0", () => {
    expect(html()).toContain(`\n\n${SUMMARY.join("\n")}\n\n⏰`);
    expect(html({ attendance: { playing: 6, notPlaying: 0, maybe: 1, noResponse: 20 } })).toContain("👥 Attendance Summary (27 players)\n✅ Playing: 6\n❌ Not Playing: 0\n🤔 Maybe: 1\n⏳ Not Responded: 20");
    expect(html({ attendance: { playing: 1, notPlaying: 0, maybe: 0, noResponse: 0 } })).toContain("👥 Attendance Summary (1 player)\n");
    expect(html({ attendance: { playing: 0, notPlaying: 0, maybe: 0, noResponse: 0 } })).toContain("👥 Attendance Summary (0 players)\n✅ Playing: 0");
    const bad = html({ attendance: { playing: Number.NaN, notPlaying: -2, maybe: 2.7, noResponse: Number.POSITIVE_INFINITY } });
    expect(bad).toContain("👥 Attendance Summary (2 players)\n✅ Playing: 0\n❌ Not Playing: 0\n🤔 Maybe: 2\n⏳ Not Responded: 0");
    expect(bad).not.toMatch(/-\d/); // never negative
  });
});

describe("weather (input only — never generated): compact, outside conditions, full disclaimer collapsed", () => {
  it("missing → no weather lines, no attribution, no disclaimer", () => {
    const h = html({ weather: null });
    expect(h).not.toMatch(/🌤|🌧|💨|WeatherAPI|blockquote/);
    expect(h).toContain("📍 ForeKicks\n\n👥 Attendance Summary");
  });
  it("two compact lines: conditions; rain · wind (only what was supplied)", () => {
    const h = html({ weather: W({ temperatureC: 21.1, condition: "Sunny", rainChancePercent: 3, windKph: 12.87 }) });
    expect(h).toContain("🌤 Outside at kickoff: 70°F, sunny\n🌧 Rain: 3% · 💨 Wind: 8 mph\n<i>Powered by");
    expect(html({ weather: W({ rainChancePercent: 60 }) })).toContain("📍 ForeKicks\n🌧 Rain: 60%\n<i>Powered by");
    expect(html({ weather: W({ windKph: 16.09 }) })).toContain("📍 ForeKicks\n💨 Wind: 10 mph\n<i>Powered by");
    expect(html({ weather: W({ condition: "Light rain" }) })).toContain("🌤 Outside at kickoff: light rain\n<i>Powered by");
    expect(html({ weather: W({ temperatureC: null, condition: "", rainChancePercent: null }) })).not.toMatch(/🌤|🌧|WeatherAPI|blockquote/);
    expect(html({ weather: W({ temperatureC: Number.NaN, rainChancePercent: Number.POSITIVE_INFINITY, windKph: -3 }) })).not.toMatch(/🌤|🌧|💨|blockquote/);
  });
  it("indoor venues: explicitly the weather OUTSIDE (never read as the hall's conditions)", () => {
    expect(html({ match: { date: "2026-10-19", startTime: "21:00", venueName: "ForeKicks", isIndoor: true } })).toContain("🌤 Outside at kickoff (indoor venue): 58°F, cloudy");
  });
  it("imperial vs metric (temperature and wind); rain chance clamped to 0–100", () => {
    const w = W({ temperatureC: 14.4, condition: "Cloudy", rainChancePercent: 140, windKph: 20 });
    expect(html({ weather: w, units: "imperial" })).toContain("🌤 Outside at kickoff: 58°F, cloudy\n🌧 Rain: 100% · 💨 Wind: 12 mph");
    expect(html({ weather: w, units: "metric" })).toContain("🌤 Outside at kickoff: 14°C, cloudy\n🌧 Rain: 100% · 💨 Wind: 20 km/h");
  });
  it("the attribution link and the COMPLETE disclaimer (verbatim) in one collapsed expandable blockquote", () => {
    const h = html();
    for (const l of LEGAL) expect(h).toContain(l);
    expect(h.match(/<blockquote expandable>/g)).toHaveLength(1);
    expect(h).toContain(WEATHER_DISCLAIMER); // every word, unshortened
    expect(DISCLAIMER_FIRST_LINE.length).toBeLessThan(60); // short visible first line
  });
  it("no forecast without its disclaimer: missing or too long to fit uncut → no weather at all (never a shortened disclaimer)", () => {
    expect(html({ weather: { temperatureC: 10, condition: "Sunny", attributionLink: WEATHER_ATTRIBUTION } })).not.toMatch(/🌤|WeatherAPI|blockquote/);
    expect(html({ weather: W({ temperatureC: 10, disclaimer: "x".repeat(5000) }) })).not.toMatch(/🌤|blockquote/);
  });
});

describe("time: the group's timezone, the actual time left, DST", () => {
  it("a late cron run states the real remaining time, not the configured offset", () => {
    expect(html({ now: new Date("2026-10-19T20:35:00Z") })).toContain("⏰ Attendance closes in 25 minutes (5:00 PM EDT).");
    expect(html({ now: new Date("2026-10-19T17:40:00Z") })).toContain("closes in 3 hours 20 minutes (5:00 PM EDT)");
    expect(html({ now: new Date("2026-10-19T20:59:30Z") })).toContain("closes in 1 minute");
  });
  it("same local day → time only; another local day → the day is named", () => {
    // 4:00 PM EDT Sunday → deadline 8:00 PM EDT the same Sunday (UTC already says Monday).
    expect(html({ now: new Date("2026-10-18T20:00:00Z"), deadline: new Date("2026-10-19T00:00:00Z"), match: { date: "2026-10-19", startTime: "21:00" } })).toContain("closes in 4 hours (8:00 PM EDT)");
    expect(html({ now: new Date("2026-10-19T02:00:00Z") })).toContain("closes in 19 hours (Monday, October 19 at 5:00 PM EDT)");
  });
  it("DST fall-back: elapsed time is real (2 h 30 min to the SECOND 1:30 AM, shown as EST); kickoff after the change in EST", () => {
    const h = html({
      match: { date: "2026-11-01", startTime: "10:00" },
      now: new Date("2026-11-01T04:00:00Z"), // 00:00 EDT
      deadline: new Date("2026-11-01T06:30:00Z"), // 01:30 EST
    });
    expect(h).toContain("📅 Sunday, November 1 · 10:00 AM EST");
    expect(h).toContain("closes in 2 hours 30 minutes (1:30 AM EST)");
  });
  it("DST spring-forward: 1 hour of real time across the gap", () => {
    expect(html({ match: { date: "2027-03-14", startTime: "12:00" }, now: new Date("2027-03-14T06:30:00Z"), deadline: new Date("2027-03-14T07:30:00Z") })).toContain(
      "closes in 1 hour (3:30 AM EDT)"
    );
  });
  it("another timezone", () => {
    expect(html({ timezone: "Europe/London", now: new Date("2026-10-19T12:00:00Z"), deadline: new Date("2026-10-19T16:00:00Z") })).toMatch(/closes in 4 hours \(5:00 PM (BST|GMT\+1)\)/);
  });
  it("a deadline that has passed (or is now) yields no message", () => {
    expect(buildGameDayUpdate(base({ now: new Date("2026-10-19T21:00:00Z") }))).toEqual({ ok: false, reason: "DEADLINE_PASSED" });
    expect(buildGameDayUpdate(base({ now: new Date("2026-10-19T22:00:00Z") }))).toEqual({ ok: false, reason: "DEADLINE_PASSED" });
  });
  it("invalid input is refused, not guessed", () => {
    expect(buildGameDayUpdate(base({ timezone: "Mars/Base" }))).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(buildGameDayUpdate(base({ match: { date: "19/10/2026", startTime: "21:00" } }))).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(buildGameDayUpdate(base({ match: { date: "2026-10-19", startTime: "9pm" } }))).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(buildGameDayUpdate(base({ deadline: new Date("nope") }))).toEqual({ ok: false, reason: "INVALID_INPUT" });
  });
  it("time-left wording", () => {
    expect([30_000, 59 * 60_000, 60 * 60_000, 61 * 60_000, 12 * 3600_000, 49 * 3600_000, 72 * 3600_000].map(timeLeftText)).toEqual([
      "1 minute",
      "59 minutes",
      "1 hour",
      "1 hour 1 minute",
      "12 hours",
      "2 days 1 hour",
      "3 days",
    ]);
  });
});

describe("safety: escaping, Unicode, links, length", () => {
  it("escapes every user string; line breaks / control characters can't inject structure", () => {
    const h = html({
      groupName: "A&B <script>alert(1)</script>",
      match: { date: "2026-10-19", startTime: "21:00", venueName: "Field\n<b>1</b>\u0000 " },
      weather: W({ temperatureC: 10, condition: "<i>sunny</i> & dry", attribution: "Weather by <x>" }),
    });
    expect(h).toContain("— A&amp;B &lt;script&gt;alert(1)&lt;/script&gt;</b>");
    expect(h).toContain("📍 Field &lt;b&gt;1&lt;/b&gt;\n");
    expect(h).toContain("&lt;i&gt;sunny&lt;/i&gt; &amp; dry");
    expect(h).toContain("<i>Weather by &lt;x&gt;</i>");
    // Only our own tags remain.
    expect(h.match(/<\/?[a-z]+[^>]*>/g)!.filter((t) => !/^<\/?(b|i)>$/.test(t) && !/^<a href="https:\/\/www\.weatherapi\.com\/">$|^<\/a>$|^<blockquote expandable>$|^<\/blockquote>$/.test(t))).toEqual([]);
  });
  it("unusual Unicode survives intact (emoji, RTL, combining marks)", () => {
    const h = html({ groupName: "Fútbol ⚽🇧🇷 فريق Ångström", match: { date: "2026-10-19", startTime: "21:00", venueName: "Ünïcödé Arena 🏟️" } });
    expect(h).toContain("— Fútbol ⚽🇧🇷 فريق Ångström</b>");
    expect(h).toContain("📍 Ünïcödé Arena 🏟️");
  });
  it("links: only a caller-supplied absolute https URL (escaped); missing / private (null) / unsafe ones are omitted", () => {
    expect(html({ link: "https://teambalancepro.com/share/m/abc#t=1&x=\"y\"" })).toContain('<a href="https://teambalancepro.com/share/m/abc#t=1&amp;x=%22y%22">Confirm or update your attendance</a>');
    for (const link of [null, undefined, "", "http://example.com/x", "javascript:alert(1)", "/share/m/abc", "not a url"]) {
      expect(html({ link, weather: null }), String(link)).not.toContain("<a "); // (weather: null — its attribution is a link)
    }
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/messaging/gameDayUpdate.ts"), "utf8");
    expect(src).not.toMatch(/matchLink|matchShare|process\.env|prisma|fetch\(/); // never builds links, reads the DB or the network
  });
  it("length: long fields are capped (code-point safe, marked truncated); the message stays far below Telegram's limit", () => {
    const r = buildGameDayUpdate(base({ groupName: "Ⓐ".repeat(5000), match: { date: "2026-10-19", startTime: "21:00", venueName: "🏟️".repeat(3000) }, weather: W({ condition: "x".repeat(9000), attribution: "y".repeat(9000), temperatureC: 1 }) }));
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && Array.from(r.html).length).toBeLessThan(TELEGRAM_TEXT_LIMIT / 2);
    expect(r.ok && r.html).toContain(`${"Ⓐ".repeat(79)}…</b>`);
    expect(r.ok && r.html).not.toMatch(/�/); // no broken surrogate pairs
  });
});
