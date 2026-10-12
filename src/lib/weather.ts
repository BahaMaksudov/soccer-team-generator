import type { GameDayWeather } from "@/lib/messaging/gameDayUpdate";
import { WEATHER_ATTRIBUTION, WEATHER_DISCLAIMER } from "@/lib/weatherLegal";

/**
 * Phase 4B (step 7) — kickoff weather for a Game Day Update. Replaceable
 * adapter; WeatherAPI.com Forecast API (forecasts only — never the "current"
 * block). Server-only key WEATHERAPI_KEY (never sent to the browser or
 * Telegram). One request, ~3 s timeout, no retry; ANY problem → null (the
 * update is then sent without weather).
 *
 * Kickoff is an absolute instant (date + start time in the Group's timezone,
 * computed by the caller), matched to the hourly entry whose `time_epoch` hour
 * contains it — epoch-based, so the location's timezone and DST can't shift it.
 * Beyond the plan's forecast horizon (Free: 3 days) nothing is requested.
 * Returns canonical metric values; the message builder converts units.
 */
export interface WeatherProvider {
  forecastAt(lat: number, lon: number, kickoff: Date, now: Date): Promise<GameDayWeather | null>;
}

/** WeatherAPI.com Free plan: today + 2 days. */
export const FORECAST_DAYS = 3;
const TIMEOUT_MS = 3000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function weatherApiProvider(apiKey: string): WeatherProvider {
  return {
    async forecastAt(lat, lon, kickoff, now) {
      const ahead = kickoff.getTime() - now.getTime();
      // Past kickoffs and kickoffs beyond the horizon (minus a day of local-date slack): no request at all.
      if (ahead < 0 || ahead > (FORECAST_DAYS - 1) * 86_400_000) return null;
      const url = `https://api.weatherapi.com/v1/forecast.json?${new URLSearchParams({ key: apiKey, q: `${lat.toFixed(4)},${lon.toFixed(4)}`, days: String(FORECAST_DAYS), aqi: "no", alerts: "no" })}`;
      let data: unknown;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        data = await res.json();
      } catch {
        return null;
      }
      const days = (data as { forecast?: { forecastday?: unknown } })?.forecast?.forecastday;
      if (!Array.isArray(days)) return null;
      const k = Math.floor(kickoff.getTime() / 1000);
      for (const day of days as Array<{ hour?: unknown }>) {
        if (!Array.isArray(day?.hour)) continue;
        for (const h of day.hour as Array<Record<string, unknown>>) {
          const start = num(h?.time_epoch);
          if (start === null || k < start || k >= start + 3600) continue;
          const condition = (h.condition as { text?: unknown } | undefined)?.text;
          const w: GameDayWeather = {
            temperatureC: num(h.temp_c),
            condition: typeof condition === "string" ? condition : null,
            rainChancePercent: num(h.chance_of_rain),
            windKph: num(h.wind_kph),
            attributionLink: WEATHER_ATTRIBUTION,
            disclaimer: WEATHER_DISCLAIMER,
          };
          return w.temperatureC === null && !w.condition && w.rainChancePercent === null && w.windKph === null ? null : w;
        }
      }
      return null; // kickoff hour not in the response (beyond the horizon)
    },
  };
}

let override: WeatherProvider | null = null;
export function setWeatherProviderForTests(p: WeatherProvider | null) {
  override = p;
}
export function weatherProvider(env: Record<string, string | undefined> = process.env): WeatherProvider | null {
  if (override) return override;
  const key = env.WEATHERAPI_KEY?.trim();
  return key ? weatherApiProvider(key) : null;
}
