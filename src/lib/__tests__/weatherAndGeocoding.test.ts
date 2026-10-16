import { describe, it, expect, vi, afterEach } from "vitest";
import { FORECAST_DAYS, weatherApiProvider } from "@/lib/weather";
import { geoapifyProvider, GeocodingUnavailableError, signCandidate, verifyCandidate } from "@/lib/geocoding";
import { WEATHER_ATTRIBUTION, WEATHER_DISCLAIMER, GEOCODING_ATTRIBUTION } from "@/lib/weatherLegal";
import { buildGameDayUpdate } from "@/lib/messaging/gameDayUpdate";
import { kickoffAt } from "@/lib/attendanceDeadline";

/** Phase 4B step 7 — weather + geocoding adapters (fetch mocked; no network). */
const H = 3600;
const KICK = new Date("2026-10-20T01:00:00Z"); // Monday Oct 19, 9:00 PM EDT
const NOW = new Date("2026-10-19T17:00:00Z");
const hour = (epoch: number, over: Record<string, unknown> = {}) => ({ time_epoch: epoch, time: "x", temp_c: 14.4, temp_f: 57.9, condition: { text: "Cloudy" }, chance_of_rain: 25, wind_kph: 13, ...over });
const forecast = (hours: unknown[]) => ({ location: { tz_id: "America/New_York" }, current: { temp_c: 99, condition: { text: "CURRENT" } }, forecast: { forecastday: [{ hour: hours }] } });
const mockFetch = (impl: (url: string) => Promise<unknown> | unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = await impl(url);
      if (r instanceof Error) throw r;
      return r as Response;
    })
  );
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

describe("WeatherAPI.com forecast adapter", () => {
  const k = Math.floor(KICK.getTime() / 1000);
  it("uses the hourly entry that CONTAINS kickoff (never 'current'); canonical metric + attribution + disclaimer", async () => {
    mockFetch(() => ok(forecast([hour(k - H, { temp_c: 1 }), hour(k, { temp_c: 14.4 }), hour(k + H, { temp_c: 30 })])));
    const w = await weatherApiProvider("KEY").forecastAt(42.36, -71.06, new Date(KICK.getTime() + 20 * 60_000), NOW);
    expect(w).toEqual({ temperatureC: 14.4, condition: "Cloudy", rainChancePercent: 25, windKph: 13, attributionLink: WEATHER_ATTRIBUTION, disclaimer: WEATHER_DISCLAIMER });
    const url = String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toMatch(/^https:\/\/api\.weatherapi\.com\/v1\/forecast\.json\?/);
    expect(url).toContain("q=42.3600%2C-71.0600");
    expect(url).toContain(`days=${FORECAST_DAYS}`);
  });
  it("kickoff hour missing / past kickoff / beyond the horizon → null (beyond the horizon: no request at all)", async () => {
    mockFetch(() => ok(forecast([hour(k + 5 * H)])));
    expect(await weatherApiProvider("KEY").forecastAt(1, 1, KICK, NOW)).toBeNull();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await weatherApiProvider("KEY").forecastAt(1, 1, new Date(NOW.getTime() - 1), NOW)).toBeNull();
    expect(await weatherApiProvider("KEY").forecastAt(1, 1, new Date(NOW.getTime() + 3 * 86_400_000), NOW)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("timeout, network error, HTTP error, malformed or empty data → null (never throws)", async () => {
    for (const r of [Object.assign(new Error("t"), { name: "TimeoutError" }), new TypeError("fetch failed"), { ok: false, status: 403, json: async () => ({ error: { code: 2008 } }) }, ok({ nope: 1 }), ok(forecast([hour(k, { temp_c: null, condition: null, chance_of_rain: "x", wind_kph: undefined })])), { ok: true, status: 200, json: async () => Promise.reject(new Error("bad json")) }]) {
      mockFetch(() => r);
      expect(await weatherApiProvider("KEY").forecastAt(1, 1, KICK, NOW)).toBeNull();
    }
  });
  it("DST: kickoff is an absolute instant (fall-back day 21:00 New York = 02:00Z next day) and matched by epoch", async () => {
    const kickoff = kickoffAt(new Date("2026-11-01T00:00:00Z"), "21:00", "America/New_York");
    expect(kickoff.toISOString()).toBe("2026-11-02T02:00:00.000Z");
    const e = Math.floor(kickoff.getTime() / 1000);
    mockFetch(() => ok(forecast([hour(e - H, { temp_c: 0 }), hour(e, { temp_c: 7 })])));
    expect((await weatherApiProvider("KEY").forecastAt(1, 1, kickoff, new Date("2026-11-01T12:00:00Z")))?.temperatureC).toBe(7);
  });
});

describe("Geoapify geocoding adapter + signed candidates", () => {
  it("parses candidates (label, city, region, country, coords); skips invalid coordinates", async () => {
    mockFetch(() => ok({ results: [{ formatted: "Norfolk, MA, United States", city: "Norfolk", state: "Massachusetts", country: "United States", postcode: "02056", lat: 42.11, lon: -71.32 }, { formatted: "Bad", lat: 999, lon: 0 }, { lat: 1, lon: 1 }] }));
    expect(await geoapifyProvider("K").search("Norfolk")).toEqual([{ label: "Norfolk, MA, United States", city: "Norfolk", region: "Massachusetts", country: "United States", postcode: "02056", lat: 42.11, lon: -71.32 }]);
    expect(String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toMatch(/^https:\/\/api\.geoapify\.com\/v1\/geocode\/search\?text=Norfolk&limit=5&format=json&apiKey=K$/);
  });
  it("provider failures throw GeocodingUnavailableError", async () => {
    for (const r of [new TypeError("x"), { ok: false, status: 401, json: async () => ({}) }, ok({ features: [] })]) {
      mockFetch(() => r);
      await expect(geoapifyProvider("K").search("x")).rejects.toBeInstanceOf(GeocodingUnavailableError);
    }
  });
  it("candidate tokens: bound to venue + organization, expire, tamper-proof, need the server secret", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-0123456789abcdef");
    const c = { label: "Norfolk", city: "Norfolk", region: "MA", country: "US", postcode: null, lat: 42.1, lon: -71.3 };
    const t = signCandidate(c, "v1", "o1", 1000)!;
    expect(verifyCandidate(t, "v1", "o1", 2000)).toEqual(c);
    expect(verifyCandidate(t, "v2", "o1", 2000)).toBeNull();
    expect(verifyCandidate(t, "v1", "o2", 2000)).toBeNull();
    expect(verifyCandidate(t, "v1", "o1", 1000 + 16 * 60_000)).toBeNull();
    const [p, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), lat: 0 })).toString("base64url");
    expect(verifyCandidate(`${forged}.${mac}`, "v1", "o1", 2000)).toBeNull();
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(signCandidate(c, "v1", "o1")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("weather attribution + disclaimer in the message", () => {
  const base = {
    groupName: "Indoor Soccer",
    timezone: "America/New_York",
    match: { date: "2026-10-19", startTime: "21:00", venueName: "ForeKicks" },
    deadline: new Date("2026-10-19T21:00:00Z"),
    attendance: { playing: 14, notPlaying: 0, maybe: 3, noResponse: 10 },
    units: "imperial" as const,
    now: NOW,
  };
  it("a linked 'Powered by WeatherAPI.com' and the complete disclaimer (collapsed blockquote) accompany any forecast; nothing without weather", () => {
    const r = buildGameDayUpdate({ ...base, weather: { temperatureC: 14.4, condition: "Cloudy", rainChancePercent: 25, attributionLink: WEATHER_ATTRIBUTION, disclaimer: WEATHER_DISCLAIMER } });
    const html = r.ok ? r.html : "";
    expect(html).toContain('<i>Powered by <a href="https://www.weatherapi.com/">WeatherAPI.com</a></i>');
    expect(html).toContain(`<blockquote expandable>⚠️ Weather disclaimer — forecasts are informational only\n${WEATHER_DISCLAIMER}</blockquote>`);
    expect(Array.from(html).length).toBeLessThan(4096);
    const none = buildGameDayUpdate({ ...base, weather: null });
    expect(none.ok && none.html).not.toMatch(/WeatherAPI|informational/);
  });
  it("the disclaimer conveys the provider's required substance; attributions are https", () => {
    for (const s of ["general informational purposes only", "probabilistic", "may not be accurate for your specific location or time", "sole basis for decisions involving personal safety", "consult official meteorological services"])
      expect(WEATHER_DISCLAIMER).toContain(s);
    for (const u of [WEATHER_ATTRIBUTION.url, GEOCODING_ATTRIBUTION.provider.url, GEOCODING_ATTRIBUTION.data.url]) expect(u).toMatch(/^https:\/\//);
  });
  it("an unsafe attribution URL is dropped", () => {
    const r = buildGameDayUpdate({ ...base, weather: { temperatureC: 1, disclaimer: WEATHER_DISCLAIMER, attributionLink: { before: "Powered by", text: "X", url: "javascript:alert(1)" } } });
    expect(r.ok && r.html).not.toContain("<a ");
  });
});
