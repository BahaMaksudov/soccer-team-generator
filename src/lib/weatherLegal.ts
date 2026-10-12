/**
 * Phase 4B (step 7) — ALL provider-required legal wording for weather and
 * geocoding, isolated here so it can be updated when a provider clarifies its
 * requirements (verified 2026-10-12):
 *
 * - WeatherAPI.com (forecasts; Free plan): https://www.weatherapi.com/pricing.aspx
 *   requires the backlink  Powered by <a href="https://www.weatherapi.com/">WeatherAPI.com</a>;
 *   https://www.weatherapi.com/terms.aspx ("End-User Disclaimer Obligation")
 *   requires a clear, conspicuous disclaimer wherever its weather data is shown
 *   to end users — the text below conveys (verbatim) the minimum it lists.
 * - Geoapify (venue geocoding; Free plan): https://www.geoapify.com/term-and-conditions/
 *   (v5, 2 Feb 2024) — OpenStreetMap attribution always, Geoapify attribution on
 *   the Free plan; https://www.geoapify.com/geocoding-api/ — storing results is
 *   allowed when the attribution is kept with / shown near the stored data.
 */
export const WEATHER_ATTRIBUTION = { before: "Powered by", text: "WeatherAPI.com", url: "https://www.weatherapi.com/" } as const;

export const WEATHER_DISCLAIMER =
  "Weather information displayed here is provided for general informational purposes only. Forecasts and conditions are probabilistic and may not be accurate for your specific location or time. This data should not be used as the sole basis for decisions involving personal safety, aviation, marine navigation, emergency planning, or other safety-critical activities. Always consult official meteorological services and relevant authorities for decisions where accuracy is critical.";

/** Shown next to every geocoded (confirmed) venue location. */
export const GEOCODING_ATTRIBUTION = {
  provider: { before: "Powered by", text: "Geoapify", url: "https://www.geoapify.com/" },
  data: { before: "©", text: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
} as const;
