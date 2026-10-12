/**
 * Phase 4B step 7 — venue weather locations (geocoding) and kickoff forecasts in
 * Game Day Updates, REAL DATABASE (guarded local test DB only). Geocoding and
 * weather providers are FAKES (injected); Telegram is a fake fetch. Nothing
 * leaves the machine.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as venuesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/route";
import * as venueRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/[venueId]/route";
import * as locationRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/[venueId]/weather-location/route";
import * as searchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/[venueId]/weather-location/search/route";
import { resetGeocodeLimitForTests, setGeocodingProviderForTests, type GeoCandidate } from "@/lib/geocoding";
import { setWeatherProviderForTests, type WeatherProvider } from "@/lib/weather";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { WEATHER_ATTRIBUTION, WEATHER_DISCLAIMER } from "@/lib/weatherLegal";
import { zonedToUtc } from "@/lib/scheduleTime";
import type { GameDayWeather } from "@/lib/messaging/gameDayUpdate";

const TZ = "America/New_York";
const H = 3600_000;
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DATE = "2099-06-03";
const D = zonedToUtc(DATE, "17:00", TZ); // deadline 5 PM EDT
const KICKOFF = zonedToUtc(DATE, "21:00", TZ); // 9 PM EDT
const at = (ms: number) => new Date(D.getTime() + ms);

// ---------------------------------------------------------------- fakes
let tg: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: { body?: string }): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  tg.push({ method: u.split("/").pop()!, body: JSON.parse(init?.body ?? "{}") });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }) } as unknown as Response;
}
const CANDIDATES: GeoCandidate[] = [
  { label: "Norfolk, MA 02056, United States", city: "Norfolk", region: "Massachusetts", country: "United States", postcode: "02056", lat: 42.1195, lon: -71.3251 },
  { label: "Norfolk, VA, United States", city: "Norfolk", region: "Virginia", country: "United States", postcode: null, lat: 36.8508, lon: -76.2859 },
  { label: "Norfolk, England, United Kingdom", city: null, region: "England", country: "United Kingdom", postcode: null, lat: 52.6, lon: 1.1 },
];
let geoMode: "ok" | "fail" = "ok";
const geoSearch = vi.fn(async () => {
  if (geoMode === "fail") throw new Error("down");
  return CANDIDATES;
});
let weatherResult: GameDayWeather | null | "throw" = null;
const weatherCalls: Array<{ lat: number; lon: number; kickoff: string; now: string }> = [];
const fakeWeather: WeatherProvider = {
  async forecastAt(lat, lon, kickoff, now) {
    weatherCalls.push({ lat, lon, kickoff: kickoff.toISOString(), now: now.toISOString() });
    if (weatherResult === "throw") throw new Error("boom");
    return weatherResult;
  },
};
const FORECAST: GameDayWeather = { temperatureC: 14.4, condition: "Cloudy", rainChancePercent: 25, windKph: 13, attributionLink: WEATHER_ATTRIBUTION, disclaimer: WEATHER_DISCLAIMER };

// ---------------------------------------------------------------- helpers
const json = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const gv = (venueId: string, org = "o") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: `${org}-g`, venueId }) });
const search = (venueId: string, query = "Norfolk", org?: string) => call(searchRoute.POST(json("POST", { query }), gv(venueId, org)));
const confirm = (venueId: string, candidate: unknown, org?: string) => call(locationRoute.POST(json("POST", { candidate }), gv(venueId, org)));
const venue = (id: string) => prisma.venue.findUniqueOrThrow({ where: { id } });

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const [o, chat] of [["o", -100n], ["x", -200n]] as const) {
    await prisma.organization.create({ data: { id: o, name: `Org ${o}`, slug: o, plan: "LEGACY" } });
    await prisma.group.create({ data: { id: `${o}-g`, organizationId: o, name: "Indoor Soccer", slug: `${o}-g`, sportKey: "soccer", timezone: TZ, visibility: "PRIVATE" } });
    await prisma.groupSetting.create({ data: { groupId: `${o}-g`, key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    await prisma.telegramChat.create({ data: { chatId: chat, title: "Chat", groupId: `${o}-g` } });
    await prisma.venue.create({ data: { id: `${o}-v`, organizationId: o, name: "ForeKicks", address: "10 Pine St, Norfolk, MA" } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "x", role: "OWNER" },
    ],
  });
}
async function confirmedVenue(id = "o-v", lat = 42.1195, lon = -71.3251) {
  await prisma.venue.update({ where: { id }, data: { weatherLatitude: lat, weatherLongitude: lon, weatherLocationLabel: "Norfolk, MA", weatherLocationConfirmedAt: new Date(), weatherLocationConfirmedByUserId: "u-owner" } });
}
/** A manual match at the venue with an open attendance poll (message 77), deadline D. */
async function match(id = "m", data: Record<string, unknown> = {}, groupId = "o-g", chat = -100n) {
  const selected = await prisma.telegramChat.findFirstOrThrow({ where: { chatId: chat, groupId }, select: { id: true } }); // destination consistency
  await prisma.match.create({ data: { id, groupId, date: new Date(`${DATE}T00:00:00Z`), startTime: "21:00", venueId: groupId === "o-g" ? "o-v" : "x-v", attendanceDeadlineAt: D, telegramChatId: selected.id, ...data } });
  await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId: chat, messageId: 77n, question: "Q", optionsJson: "[]", groupId, matchId: id, kind: "ATTENDANCE", createdAt: at(-24 * H) } });
}
const sentText = () => String(tg.filter((c) => c.method === "sendMessage").at(-1)?.body.text ?? "");

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("NEXTAUTH_SECRET", "phase4b-weather-test-secret-0123456789");
  setGeocodingProviderForTests({ search: geoSearch });
  setWeatherProviderForTests(fakeWeather);
});
beforeEach(async () => {
  tg = [];
  weatherCalls.length = 0;
  weatherResult = FORECAST;
  geoMode = "ok";
  geoSearch.mockClear();
  resetGeocodeLimitForTests();
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  setGeocodingProviderForTests(null);
  setWeatherProviderForTests(null);
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ================================================================ venue locations
describe("venue weather location: search → explicit choice → confirm", () => {
  it("search returns several candidates (city / region / country) and stores NOTHING", async () => {
    const r = await search("o-v");
    expect(r.status).toBe(200);
    const c = r.body.candidates as Array<{ label: string; city: string | null; region: string | null; country: string | null; token: string }>;
    expect(c.map((x) => [x.label, x.region, x.country])).toEqual(CANDIDATES.map((x) => [x.label, x.region, x.country]));
    expect(c.every((x) => typeof x.token === "string" && x.token.includes("."))).toBe(true);
    expect(await venue("o-v")).toMatchObject({ weatherLatitude: null, weatherLongitude: null, weatherLocationLabel: null, weatherLocationConfirmedAt: null });
  });

  it("confirming ONE chosen candidate stores its coordinates, label and who/when; replace and remove work", async () => {
    const c = (await search("o-v")).body.candidates as Array<{ token: string }>;
    expect((await confirm("o-v", c[1].token)).status).toBe(200); // the organizer picked Virginia
    expect(await venue("o-v")).toMatchObject({ weatherLatitude: 36.8508, weatherLongitude: -76.2859, weatherLocationLabel: "Norfolk, VA, United States", weatherLocationConfirmedByUserId: "u-owner" });
    const again = (await search("o-v")).body.candidates as Array<{ token: string }>;
    expect((await confirm("o-v", again[0].token)).status).toBe(200); // replace
    expect((await venue("o-v")).weatherLatitude).toBe(42.1195);
    // The list shows the label (coordinates stay server-side).
    const list = (await call(venuesRoute.GET(json("GET"), { params: Promise.resolve({ organizationSlug: "o", groupSlug: "o-g" }) }))).body.venues as Array<Record<string, unknown>>;
    expect(list.find((v) => v.id === "o-v")).toMatchObject({ weatherLocation: { label: "Norfolk, MA 02056, United States" } });
    expect(JSON.stringify(list)).not.toMatch(/42\.1195|weatherLatitude/);
    expect((await call(locationRoute.DELETE(json("DELETE"), gv("o-v")))).status).toBe(200);
    expect(await venue("o-v")).toMatchObject({ weatherLatitude: null, weatherLocationLabel: null, weatherLocationConfirmedAt: null });
  });

  it("forged, edited, other-venue and other-organization candidates are refused; nothing is stored", async () => {
    await prisma.venue.create({ data: { id: "o-v2", organizationId: "o", name: "Other ground" } });
    const t = ((await search("o-v")).body.candidates as Array<{ token: string }>)[0].token;
    for (const bad of [t.replace(/.$/, (ch) => (ch === "A" ? "B" : "A")), "not-a-token", { lat: 1, lon: 1 }]) expect((await confirm("o-v", bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await confirm("o-v2", t)).status).toBe(400); // signed for another venue
    expect((await venue("o-v")).weatherLatitude).toBeNull();
    expect((await venue("o-v2")).weatherLatitude).toBeNull();
  });

  it("changing the address clears the confirmed location; the same address or other edits don't", async () => {
    await confirmedVenue();
    expect((await call(venueRoute.PATCH(json("PATCH", { name: "ForeKicks Dome", address: "10 Pine St, Norfolk, MA" }), gv("o-v")))).body).toEqual({ ok: true });
    expect((await venue("o-v")).weatherLatitude).toBe(42.1195);
    expect((await call(venueRoute.PATCH(json("PATCH", { isIndoor: true }), gv("o-v")))).status).toBe(200);
    expect(await venue("o-v")).toMatchObject({ isIndoor: true, weatherLatitude: 42.1195 });
    expect((await call(venueRoute.PATCH(json("PATCH", { address: "1 Main St, Walpole, MA" }), gv("o-v")))).body).toEqual({ ok: true, weatherLocationCleared: true });
    expect(await venue("o-v")).toMatchObject({ weatherLatitude: null, weatherLongitude: null, weatherLocationLabel: null, weatherLocationConfirmedAt: null, weatherLocationConfirmedByUserId: null, isIndoor: true });
  });

  it("OWNER and ADMIN only; MEMBER and other organizations get 404 (search, confirm, remove, indoor)", async () => {
    const t = ((await search("o-v")).body.candidates as Array<{ token: string }>)[0].token;
    signIn("admin");
    expect((await search("o-v")).status).toBe(200);
    signIn("member");
    expect((await search("o-v")).status).toBe(404);
    expect((await confirm("o-v", t)).status).toBe(404);
    expect((await call(locationRoute.DELETE(json("DELETE"), gv("o-v")))).status).toBe(404);
    expect((await call(venueRoute.PATCH(json("PATCH", { isIndoor: true }), gv("o-v")))).status).toBe(404);
    signIn("other");
    expect((await search("o-v")).status).toBe(404); // via our group
    expect((await search("o-v", "Norfolk", "x")).status).toBe(404); // our venue through their own group
    expect((await confirm("o-v", t, "x")).status).toBe(404);
    expect((await venue("o-v")).weatherLatitude).toBeNull();
  });

  it("rate limit: 20 searches per organizer per 10 minutes, then 429 (no provider call)", async () => {
    for (let i = 0; i < 20; i++) expect((await search("o-v", `Norfolk ${i}`)).status).toBe(200);
    expect(await search("o-v", "one more")).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(geoSearch).toHaveBeenCalledTimes(20);
  });

  it("provider down → 502 without storing; not configured → 503; bad queries → 400", async () => {
    geoMode = "fail";
    expect(await search("o-v")).toMatchObject({ status: 502, body: { code: "UNAVAILABLE" } });
    setGeocodingProviderForTests(null);
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    expect(await search("o-v")).toMatchObject({ status: 503, body: { code: "NOT_CONFIGURED" } });
    setGeocodingProviderForTests({ search: geoSearch });
    expect((await search("o-v", "x")).status).toBe(400);
    expect((await venue("o-v")).weatherLatitude).toBeNull();
  });
});

// ================================================================ forecasts in Game Day Updates
describe("kickoff forecasts in the Game Day Update", () => {
  it("confirmed venue + weather on: the forecast for KICKOFF (not the reminder time), with linked attribution and the disclaimer", async () => {
    await confirmedVenue();
    await match();
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(1);
    expect(weatherCalls).toEqual([{ lat: 42.1195, lon: -71.3251, kickoff: KICKOFF.toISOString(), now: at(-3 * H).toISOString() }]);
    const text = sentText();
    expect(text).toContain("🌤 Kickoff forecast: 58°F, cloudy");
    expect(text).toContain("🌧 Rain chance: 25%");
    expect(text).toContain('<i>Powered by <a href="https://www.weatherapi.com/">WeatherAPI.com</a></i>');
    expect(text).toContain(`⚠️ <i>${WEATHER_DISCLAIMER}</i>`);
    expect(tg.at(-1)!.body).toMatchObject({ reply_parameters: { message_id: 77, allow_sending_without_reply: false }, parse_mode: "HTML" });
  });

  it("indoor venue → 'Outside at kickoff'; metric units → °C / km/h", async () => {
    await confirmedVenue();
    await prisma.venue.update({ where: { id: "o-v" }, data: { isIndoor: true } });
    await prisma.groupSetting.update({ where: { groupId_key: { groupId: "o-g", key: "gameDayUpdate" } }, data: { value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "metric" }) } });
    await match();
    await runMatchAutomation(at(-3 * H));
    expect(sentText()).toContain("🌤 Outside at kickoff: 14°C, cloudy");
    expect(sentText()).toContain("💨 Wind: 13 km/h");
  });

  it("no weather request when: weather is off, the location is unconfirmed, or the match has no start time — the update is still sent", async () => {
    await confirmedVenue();
    await prisma.groupSetting.update({ where: { groupId_key: { groupId: "o-g", key: "gameDayUpdate" } }, data: { value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: false, units: "imperial" }) } });
    await match("off");
    await runMatchAutomation(at(-3 * H));
    expect(sentText()).not.toMatch(/forecast|WeatherAPI/);
    await prisma.groupSetting.update({ where: { groupId_key: { groupId: "o-g", key: "gameDayUpdate" } }, data: { value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    await prisma.venue.update({ where: { id: "o-v" }, data: { weatherLocationConfirmedAt: null } });
    await prisma.telegramPoll.deleteMany({});
    await match("unconfirmed");
    await runMatchAutomation(at(-3 * H));
    await prisma.telegramPoll.deleteMany({});
    await confirmedVenue();
    await match("notime", { startTime: null });
    await runMatchAutomation(at(-3 * H));
    expect(weatherCalls).toHaveLength(0);
    expect(tg.filter((c) => c.method === "sendMessage")).toHaveLength(3);
  });

  it("weather unavailable (null), provider error, or beyond the horizon → sent WITHOUT weather (never blocked)", async () => {
    await confirmedVenue();
    weatherResult = "throw";
    await match("a");
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(1);
    expect(sentText()).not.toMatch(/forecast|WeatherAPI|informational/);
    weatherResult = null;
    await prisma.telegramPoll.deleteMany({});
    await match("b");
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(1);
    expect(sentText()).not.toMatch(/forecast|WeatherAPI/);
  });

  it("weather is fetched only for an update that is due (not on every run), and parallel runs still send once", async () => {
    await confirmedVenue();
    await match();
    await runMatchAutomation(at(-5 * H)); // not due yet
    expect(weatherCalls).toHaveLength(0);
    const t = at(-3 * H);
    await Promise.all([runMatchAutomation(t), runMatchAutomation(t), runMatchAutomation(t, { groupId: "o-g", matchId: "m" })]);
    expect(tg.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(await prisma.messageDelivery.count({ where: { matchId: "m", eventType: "GAME_DAY_UPDATE_POSTED", status: "SENT" } })).toBe(1);
    await runMatchAutomation(at(-H));
    expect(tg.filter((c) => c.method === "sendMessage")).toHaveLength(1); // never a second update
  });

  it("tenant isolation: another organization's venue coordinates are never used for our match", async () => {
    await confirmedVenue("x-v", 1.5, 2.5);
    await match();
    await runMatchAutomation(at(-3 * H), { groupId: "o-g" });
    expect(weatherCalls).toHaveLength(0); // our venue has no confirmed location
    expect(sentText()).not.toMatch(/forecast/);
  });

  it("no network beyond the fake Telegram (providers are injected fakes)", () => {
    expect(otherNetwork).toBe(0);
  });
});
