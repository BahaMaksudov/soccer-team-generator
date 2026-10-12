import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PREVIEW_TTL_MS, signGameDayConfirm, verifyGameDayConfirm, type GameDayConfirmClaims } from "@/lib/gameDayConfirmToken";
import { parseTelegramHtml } from "@/lib/telegramHtmlPreview";
import { GameDayUpdateReview, TelegramMessagePreview } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/GameDayUpdateDialog";
import type { GameDayPreview } from "@/lib/gameDayUpdate";

/** Manual Game Day Update — confirmation token, safe preview rendering, review panel (pure; no network). */
beforeAll(() => vi.stubEnv("NEXTAUTH_SECRET", "unit-test-secret-0123456789abcdef"));
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.UTC(2099, 5, 3, 18, 0);
const claims = (over: Partial<Omit<GameDayConfirmClaims, "exp">> = {}): Omit<GameDayConfirmClaims, "exp"> => ({
  o: "org",
  g: "grp",
  m: "match",
  u: "user",
  p: "poll",
  c: "-1001",
  d: T0 + 3 * 3600_000,
  pl: 9,
  mb: 2,
  w: null,
  h: "a".repeat(64),
  iat: T0,
  ...over,
});
const who = { o: "org", g: "grp", m: "match", u: "user" };

describe("confirmation token", () => {
  it("round-trips within its 2-minute validity; expires after it", () => {
    expect(PREVIEW_TTL_MS).toBe(120_000);
    const t = signGameDayConfirm(claims())!;
    expect(verifyGameDayConfirm(t, who, T0 + 119_000)).toMatchObject({ ok: true, claims: { p: "poll", c: "-1001", pl: 9, mb: 2, exp: T0 + PREVIEW_TTL_MS } });
    expect(verifyGameDayConfirm(t, who, T0 + PREVIEW_TTL_MS)).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("is bound to the organization, group, match and reviewing user", () => {
    const t = signGameDayConfirm(claims())!;
    for (const k of ["o", "g", "m", "u"] as const) expect(verifyGameDayConfirm(t, { ...who, [k]: "other" }, T0)).toEqual({ ok: false, reason: "INVALID" });
  });
  it("rejects tampering, garbage and a missing secret", () => {
    const t = signGameDayConfirm(claims())!;
    const [payload, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), c: "-999" })).toString("base64url");
    expect(verifyGameDayConfirm(`${forged}.${mac}`, who, T0)).toEqual({ ok: false, reason: "INVALID" });
    expect(verifyGameDayConfirm(`${payload}.${mac}x`, who, T0)).toEqual({ ok: false, reason: "INVALID" });
    expect(verifyGameDayConfirm(`${payload}.${mac}.x`, who, T0)).toEqual({ ok: false, reason: "INVALID" });
    for (const bad of [null, 42, "", "a.b", "x".repeat(9000)]) expect(verifyGameDayConfirm(bad, who, T0)).toEqual({ ok: false, reason: "INVALID" });
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(signGameDayConfirm(claims())).toBeNull();
    expect(verifyGameDayConfirm(t, who, T0)).toEqual({ ok: false, reason: "INVALID" });
    vi.stubEnv("NEXTAUTH_SECRET", "unit-test-secret-0123456789abcdef");
  });
});

describe("safe Telegram preview (no HTML injection)", () => {
  it("bold, italic and https links become segments; entities are decoded once", () => {
    const lines = parseTelegramHtml('<b>⚽ Game Day — A &amp; B</b>\n<i>Powered by <a href="https://www.weatherapi.com/">WeatherAPI.com</a></i>\n1 &lt; 2');
    expect(lines[0]).toEqual([{ text: "⚽ Game Day — A & B", bold: true, italic: false, href: null }]);
    expect(lines[1]).toEqual([
      { text: "Powered by ", bold: false, italic: true, href: null },
      { text: "WeatherAPI.com", bold: false, italic: true, href: "https://www.weatherapi.com/" },
    ]);
    expect(lines[2]).toEqual([{ text: "1 < 2", bold: false, italic: false, href: null }]);
  });
  it("non-https links lose their link; other tags stay literal text; rendering never emits them as markup", () => {
    expect(parseTelegramHtml('<a href="javascript:alert(1)">x</a>')[0]).toEqual([{ text: "x", bold: false, italic: false, href: null }]);
    const html = renderToStaticMarkup(createElement(TelegramMessagePreview, { html: '<script>alert(1)</script><img src=x onerror=1><a href="http://x">y</a>' }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="http://x"');
    expect(html).toContain("&lt;script&gt;");
  });
});

const preview = (over: Partial<GameDayPreview> = {}): GameDayPreview => ({
  state: "READY",
  reason: null,
  text: "Ready to send.",
  organization: "Funny Org",
  group: "Indoor Soccer",
  destination: { chatTitle: "FunnyStuff", pollQuestion: "Soccer Wed Jun 3 9 PM?", pollPostedAt: new Date(T0 - 3600_000).toISOString() },
  deadline: { at: new Date(T0 + 3 * 3600_000).toISOString(), timeLeft: "3 hours" },
  message: { html: "<b>⚽ Game Day Update — Indoor Soccer</b>\n⏰ Attendance closes in 3 hours (5:00 PM EDT).", truncated: false },
  weather: { reason: "INCLUDED", includedInMessage: true, forecast: { temperatureC: 20, condition: "Partly cloudy", rainChancePercent: 10, windKph: 16.09 } },
  automaticEnabled: false,
  units: "imperial",
  token: "tok",
  expiresAt: new Date(T0 + PREVIEW_TTL_MS).toISOString(),
  expiresInSeconds: 120,
  sent: null,
  uncertainDeliveryId: null,
  ...over,
});
const noop = () => {};
const review = (p: GameDayPreview, over: Partial<Parameters<typeof GameDayUpdateReview>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GameDayUpdateReview, {
      preview: p,
      timezone: "America/New_York",
      justSent: false,
      confirmed: false,
      onConfirmedChange: noop,
      secondsLeft: 100,
      busy: false,
      feedback: null,
      markChecked: false,
      onMarkCheckedChange: noop,
      onSend: noop,
      onRefresh: noop,
      onMarkSent: noop,
      ...over,
    })
  );
const sendButton = (html: string) => html.match(/<button[^>]*>Send to [^<]*<\/button>/)?.[0] ?? "";

describe("review panel", () => {
  it("shows organization, group, Telegram group, the poll replied to, the deadline, the exact message and the weather check", () => {
    const html = review(preview());
    for (const s of ["Funny Org", "Indoor Soccer", "FunnyStuff", "Soccer Wed Jun 3 9 PM?", "Attendance closes", "in 3 hours", "exactly what will be sent", "68°F", "Partly cloudy", "rain 10%", "wind 10 mph", "Ready"]) expect(html).toContain(s);
    expect(html).toContain("Automatic Game Day Updates stay off");
  });
  it("Send needs the explicit confirmation checkbox, an unexpired preview and is labeled with the destination", () => {
    expect(sendButton(review(preview()))).toContain('disabled=""');
    expect(sendButton(review(preview(), { confirmed: true }))).not.toContain('disabled=""');
    expect(sendButton(review(preview(), { confirmed: true }))).toContain("Send to FunnyStuff");
    const expired = review(preview(), { confirmed: true, secondsLeft: 0 });
    expect(sendButton(expired)).toContain('disabled=""');
    expect(expired).toContain("Refresh preview");
  });
  it("statuses: Sent, Already sent, Uncertain (mark as sent only after checking), Unavailable (no Send)", () => {
    expect(review(preview(), { justSent: true })).toContain(">Sent<");
    const already = review(preview({ state: "ALREADY_SENT", reason: "SENT", token: null, sent: { at: new Date(T0).toISOString(), by: "Owner", markedSent: false } }));
    expect(already).toContain("Already sent");
    expect(already).toContain("by Owner");
    expect(sendButton(already)).toBe("");
    const uncertain = review(preview({ state: "UNCERTAIN", reason: "UNCERTAIN", token: null, uncertainDeliveryId: "d1" }));
    expect(uncertain).toContain("Uncertain");
    expect(uncertain).toMatch(/<button[^>]*disabled=""[^>]*>Mark as sent<\/button>/);
    expect(sendButton(uncertain)).toBe("");
    expect(review(preview({ state: "UNCERTAIN", reason: "UNCERTAIN", token: null, uncertainDeliveryId: "d1" }), { markChecked: true })).toMatch(/<button(?![^>]*disabled="")[^>]*>Mark as sent<\/button>/);
    const noDeadline = review(preview({ state: "UNAVAILABLE", reason: "NO_DEADLINE", text: "This match has no attendance deadline. Set one in Edit match", token: null, deadline: null, message: null }));
    expect(noDeadline).toContain("Unavailable");
    expect(noDeadline).toContain("Set one in Edit match");
    expect(sendButton(noDeadline)).toBe("");
  });
});
