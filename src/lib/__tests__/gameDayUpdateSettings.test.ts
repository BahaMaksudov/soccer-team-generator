import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GAME_DAY_UPDATE_DEFAULTS, gameDayUpdateSchema, parseGameDayUpdateSettings, type GameDayUpdateView } from "@/lib/gameDayUpdateSettings";
import GameDayUpdateSection from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/settings/GameDayUpdateSection";

/** Phase 4B step 4 — Game Day Update settings: defaults, validation, and the accessible card. */
describe("settings format", () => {
  it("defaults: OFF, 4 hours, weather on, imperial — for any Group without the row", () => {
    expect(GAME_DAY_UPDATE_DEFAULTS).toEqual({ enabled: false, hoursBefore: 4, includeWeather: true, units: "imperial" });
    expect(parseGameDayUpdateSettings(null)).toEqual(GAME_DAY_UPDATE_DEFAULTS);
  });
  it("stored values are read per field; malformed or unsupported ones fall back to their default", () => {
    expect(parseGameDayUpdateSettings(JSON.stringify({ enabled: true, hoursBefore: 12, includeWeather: false, units: "metric" }))).toEqual({ enabled: true, hoursBefore: 12, includeWeather: false, units: "metric" });
    expect(parseGameDayUpdateSettings(JSON.stringify({ enabled: "yes", hoursBefore: 3, units: "kelvin" }))).toEqual(GAME_DAY_UPDATE_DEFAULTS);
    expect(parseGameDayUpdateSettings("{not json")).toEqual(GAME_DAY_UPDATE_DEFAULTS);
    expect(parseGameDayUpdateSettings("[1,2]")).toEqual(GAME_DAY_UPDATE_DEFAULTS);
  });
  it("writes: only 2/4/6/12 hours and imperial/metric; every field required; tenant ids stripped", () => {
    const ok = { enabled: true, hoursBefore: 6, includeWeather: true, units: "metric" };
    expect(gameDayUpdateSchema.safeParse(ok).success).toBe(true);
    for (const h of [0, 1, 3, 5, 8, 24, "4", null]) expect(gameDayUpdateSchema.safeParse({ ...ok, hoursBefore: h }).success, String(h)).toBe(false);
    for (const u of ["kelvin", "", "IMPERIAL", null]) expect(gameDayUpdateSchema.safeParse({ ...ok, units: u }).success, String(u)).toBe(false);
    expect(gameDayUpdateSchema.safeParse({ enabled: true }).success).toBe(false);
    const stripped = gameDayUpdateSchema.parse({ ...ok, groupId: "other", organizationId: "other" });
    expect(stripped).toEqual(ok);
  });
});

describe("Game Day Update card (static render)", () => {
  const view = (over: Partial<GameDayUpdateView> = {}, settings = {}): GameDayUpdateView => ({ settings: { ...GAME_DAY_UPDATE_DEFAULTS, ...settings }, telegramAvailable: true, planMessage: null, ...over });
  const render = (v: GameDayUpdateView) => renderToStaticMarkup(createElement(GameDayUpdateSection, { organizationSlug: "o", groupSlug: "g", initial: v }));

  it("eligible plan: accessible switches, labelled selects (2/4/6/12; °F/mph, °C/km/h) and the explanations", () => {
    const html = render(view());
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toMatch(/role="switch" aria-checked="false" aria-labelledby="[^"]+-enabled-label"/);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-labelledby="[^"]+-weather-label"/); // weather on by default
    for (const h of [2, 4, 6, 12]) expect(html).toContain(`>${h} hours before attendance closes<`);
    expect(html).toContain(">°F and mph<");
    expect(html).toContain(">°C and km/h<");
    expect(html).toMatch(/<label for="([^"]+-hours)"[\s\S]*?<select id="\1"/);
    expect(html).toMatch(/<label for="([^"]+-units)"[\s\S]*?<select id="\1"/);
    expect(html).toContain("Timed from the match&#x27;s attendance closing time — not from kickoff.");
    expect(html).toContain("Needs a confirmed weather location on the match&#x27;s venue");
    expect(html).toContain("Only for matches with an attendance deadline and an attendance poll posted to Telegram.");
    expect(html).not.toMatch(/<fieldset disabled/);
    // Responsive: full-width controls on phones, fixed width only from sm.
    expect(html).toContain("w-full");
    expect(html).toContain("sm:w-64");
  });
  it("plan without Telegram: the existing upgrade explanation; nothing can be turned on", () => {
    const html = render(view({ telegramAvailable: false, planMessage: "Your Free plan limit has been reached (Telegram integration is part of Pro; players use the match link). Pro plans and upgrades are coming soon." }));
    expect(html).toContain("Telegram integration is part of Pro");
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(/<button[^>]*-enabled-label"[^>]*>/.exec(html)![0]).toContain('disabled=""');
  });
  it("downgraded with updates still on: the switch stays usable so it can be turned off", () => {
    const html = render(view({ telegramAvailable: false, planMessage: "x" }, { enabled: true }));
    const enabledSwitch = /<button[^>]*-enabled-label"[^>]*>/.exec(html)![0];
    expect(enabledSwitch).toContain('aria-checked="true"');
    expect(enabledSwitch).not.toContain('disabled=""');
  });
});
