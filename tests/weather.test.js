import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bandForTemperature,
  currentRoundedPosition,
  describeDay,
  fetchForecast,
  forecastNote,
  parseDailyForecast,
  roundCoordinate,
  searchPlaces,
} from '../src/lib/weather.js';
import { getWeatherLocation, setWeatherLocation } from '../src/lib/settings.js';

const OPEN_METEO = {
  daily: {
    time: ['2026-10-08', '2026-10-09'],
    temperature_2m_max: [21.9, 12.4],
    temperature_2m_min: [6.2, 4.1],
    precipitation_probability_max: [0, 80],
  },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('weather', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns the forecast into the app\'s weather words, weighted to the daytime high', () => {
    const [dry, wet] = parseDailyForecast(OPEN_METEO);
    expect(dry).toMatchObject({ date: '2026-10-08', max: 22, min: 6, rainChance: 0, rain: false, temperature: 17, weather: 'mild' });
    expect(wet).toMatchObject({ rain: true, rainChance: 80, temperature: 10, weather: 'cool' });
  });

  it('bands temperatures the same way the weather chips do', () => {
    expect([4, 12, 20, 26, 33].map(bandForTemperature)).toEqual(['cold', 'cool', 'mild', 'warm', 'hot']);
  });

  it('describes a day for people and for the stylist', () => {
    const [dry, wet] = parseDailyForecast(OPEN_METEO);
    expect(describeDay(dry)).toBe('6–22°');
    expect(describeDay(wet)).toBe('4–12° · 80% rain');
    expect(forecastNote(wet, 'Melbourne')).toBe('Forecast in Melbourne: 4 to 12 degrees Celsius, rain likely (80%).');
    expect(forecastNote(null)).toBe('');
  });

  it('only ever sends a location rounded to one decimal place', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OPEN_METEO));
    await fetchForecast({ latitude: -37.81361, longitude: 144.96332 }, { days: 30, fetchImpl });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('latitude')).toBe('-37.8');
    expect(url.searchParams.get('longitude')).toBe('145');
    expect(url.searchParams.get('forecast_days')).toBe('16');
  });

  it('rounds the device position before it leaves the function', async () => {
    const geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 51.50735, longitude: -0.12776 } }) };
    expect(await currentRoundedPosition({ geolocation })).toMatchObject({ latitude: 51.5, longitude: -0.1 });
    const declined = { getCurrentPosition: (ok, fail) => fail({ code: 1 }) };
    await expect(currentRoundedPosition({ geolocation: declined })).rejects.toThrow('declined');
    expect(roundCoordinate('12.349')).toBe(12.3);
  });

  it('finds places by name, with readable names and rounded coordinates', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [
      { name: 'Melbourne', admin1: 'Victoria', country: 'Australia', latitude: -37.814, longitude: 144.96332 },
      { name: 'Singapore', admin1: 'Singapore', country: 'Singapore', latitude: 1.28967, longitude: 103.85007 },
    ] }));
    const places = await searchPlaces('Mel', { fetchImpl });
    expect(places[0]).toEqual({ name: 'Melbourne, Victoria, Australia', shortName: 'Melbourne', latitude: -37.8, longitude: 145 });
    expect(places[1].name).toBe('Singapore');
    expect(await searchPlaces(' a ', { fetchImpl })).toEqual([]);
    expect(await searchPlaces('Nowhere', { fetchImpl: async () => jsonResponse({}) })).toEqual([]);
  });

  it('says plainly when the service can\'t be reached or answers badly', async () => {
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: async () => { throw new TypeError('offline'); } })).rejects.toThrow('Could not reach the weather service');
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: async () => jsonResponse({}, 500) })).rejects.toThrow('error (500)');
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: async () => jsonResponse({ nope: 1 }) })).rejects.toThrow('could not read');
  });
});

describe('saved weather location', () => {
  const store = new Map();
  afterEach(() => { store.clear(); vi.unstubAllGlobals(); });

  it('is off by default, rounds what it stores, and turns off again', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    expect(getWeatherLocation()).toBeNull();
    setWeatherLocation({ name: 'Home', shortName: 'home', latitude: -37.81361, longitude: 144.96332 });
    expect(getWeatherLocation()).toEqual({ name: 'Home', shortName: 'home', latitude: -37.8, longitude: 145 });
    expect(JSON.parse([...store.values()][0])).toMatchObject({ latitude: -37.8, longitude: 145 });
    setWeatherLocation(null);
    expect(getWeatherLocation()).toBeNull();
  });

  it('treats corrupt storage as off', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem() {}, removeItem() {} });
    expect(getWeatherLocation()).toBeNull();
  });
});
