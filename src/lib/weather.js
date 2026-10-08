/**
 * Live weather from Open-Meteo: free, no key, and callable straight from the
 * browser (it sends Access-Control-Allow-Origin: *).
 *
 * Off until the person turns it on in Settings. A location from the device is
 * rounded to one decimal place (roughly 10 km) before it is stored or sent,
 * so the forecast is for the area, not the house. A typed city never touches
 * the device's location at all.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const MAX_FORECAST_DAYS = 16;

export function roundCoordinate(value) {
  return Math.round(Number(value) * 10) / 10;
}

/** The app's weather vocabulary, from how warm a day will feel. */
export function bandForTemperature(celsius) {
  if (celsius < 10) return 'cold';
  if (celsius < 17) return 'cool';
  if (celsius < 23) return 'mild';
  if (celsius < 29) return 'warm';
  return 'hot';
}

// What to dress for is closer to the daytime high than the overnight low, but
// a cold morning still matters, so it's weighted towards the high.
export function feelsLikeForDay(max, min) {
  return Math.round(max - (max - min) * 0.3);
}

export const RAIN_LIKELY_PERCENT = 50;

/**
 * Turns Open-Meteo's daily arrays into one entry per day.
 */
export function parseDailyForecast(body) {
  const daily = body?.daily;
  if (!daily || !Array.isArray(daily.time)) throw new Error('The weather service sent something this app could not read.');

  return daily.time.map((date, index) => {
    const max = Number(daily.temperature_2m_max?.[index]);
    const min = Number(daily.temperature_2m_min?.[index]);
    const rainChance = Number(daily.precipitation_probability_max?.[index]) || 0;
    const feelsLike = feelsLikeForDay(max, min);
    return {
      date,
      max: Math.round(max),
      min: Math.round(min),
      rainChance,
      rain: rainChance >= RAIN_LIKELY_PERCENT,
      temperature: feelsLike,
      weather: bandForTemperature(feelsLike),
    };
  });
}

/** One line a person can read at a glance: "13–21° · 40% rain". */
export function describeDay(day) {
  if (!day) return '';
  return `${day.min}–${day.max}°${day.rainChance ? ` · ${day.rainChance}% rain` : ''}`;
}

/** The sentence given to the AI stylist, so it can dress for the whole day. */
export function forecastNote(day, placeName = '') {
  if (!day) return '';
  const where = placeName ? ` in ${placeName}` : '';
  const rain = day.rain ? `, rain likely (${day.rainChance}%)` : day.rainChance ? `, ${day.rainChance}% chance of rain` : ', dry';
  return `Forecast${where}: ${day.min} to ${day.max} degrees Celsius${rain}.`;
}

export async function fetchForecast({ latitude, longitude }, { days = 7, fetchImpl = globalThis.fetch } = {}) {
  const params = new URLSearchParams({
    latitude: String(roundCoordinate(latitude)),
    longitude: String(roundCoordinate(longitude)),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: String(Math.min(MAX_FORECAST_DAYS, Math.max(1, days))),
  });

  let response;
  try {
    response = await fetchImpl(`${FORECAST_URL}?${params}`);
  } catch {
    throw new Error('Could not reach the weather service. Check your connection.');
  }
  if (!response.ok) throw new Error(`The weather service returned an error (${response.status}).`);
  return parseDailyForecast(await response.json());
}

/** Looks a place up by name. Returns up to five matches, most likely first. */
export async function searchPlaces(query, { fetchImpl = globalThis.fetch } = {}) {
  const name = String(query || '').trim();
  if (name.length < 2) return [];

  const params = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
  let response;
  try {
    response = await fetchImpl(`${GEOCODING_URL}?${params}`);
  } catch {
    throw new Error('Could not reach the weather service. Check your connection.');
  }
  if (!response.ok) throw new Error(`The place search returned an error (${response.status}).`);
  const body = await response.json();

  return (body?.results || []).map((place) => ({
    name: [place.name, place.admin1, place.country].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(', '),
    shortName: place.name,
    latitude: roundCoordinate(place.latitude),
    longitude: roundCoordinate(place.longitude),
  }));
}

/** The device's location, rounded to about 10 km before it leaves this function. */
export function currentRoundedPosition({ geolocation = globalThis.navigator?.geolocation } = {}) {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new Error('This browser cannot share a location. Type a city instead.'));
      return;
    }
    geolocation.getCurrentPosition(
      (position) => resolve({
        name: 'Your area',
        shortName: 'your area',
        latitude: roundCoordinate(position.coords.latitude),
        longitude: roundCoordinate(position.coords.longitude),
      }),
      (error) => reject(new Error(error?.code === 1
        ? 'Location permission was declined. Type a city instead.'
        : 'Your location could not be found. Type a city instead.')),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 3_600_000 },
    );
  });
}
