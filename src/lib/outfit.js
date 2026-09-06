const WEATHER_TERMS = {
  hot: ["summer", "hot", "warm", "lightweight", "all-season", "all season"],
  warm: ["summer", "warm", "hot", "lightweight", "all-season", "all season"],
  mild: ["spring", "autumn", "fall", "mild", "all-season", "all season"],
  cool: ["autumn", "fall", "spring", "cool", "mild", "all-season", "all season"],
  cold: ["winter", "cold", "cool", "warm", "layering", "all-season", "all season"],
  rainy: ["rain", "rainy", "waterproof", "wet", "all-season", "all season"]
};

const OCCASION_TERMS = {
  casual: ["casual", "relaxed", "everyday", "streetwear"],
  work: ["work", "smart casual", "business", "formal"],
  date: ["date", "dressy", "romantic", "smart casual", "formal"],
  formal: ["formal", "dressy", "evening", "business"],
  active: ["sporty", "athleisure", "active", "casual"],
  party: ["party", "dressy", "evening", "statement", "formal"]
};

// The question screen shows friendly labels; scoring uses the keys above.
const OCCASION_KEYS = new Map([
  ["everyday", "casual"],
  ["casual", "casual"],
  ["work", "work"],
  ["dinner", "date"],
  ["date night", "date"],
  ["date", "date"],
  ["event", "formal"],
  ["formal", "formal"],
  ["active", "active"],
  ["party", "party"]
]);

export function occasionKey(label) {
  return OCCASION_KEYS.get(String(label || "").trim().toLowerCase()) || "casual";
}

function normalized(values = []) {
  return values.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
}

export function isRecentlyWorn(lastWornDate, repeatDays = 7, now = new Date()) {
  if (!lastWornDate) return false;
  const wornAt = new Date(`${lastWornDate}T00:00:00`);
  if (Number.isNaN(wornAt.getTime())) return false;
  const diffDays = Math.floor((now - wornAt) / 86_400_000);
  return diffDays >= 0 && diffDays < Number(repeatDays || 0);
}

export function itemMatchesWeather(item, weather) {
  if (!weather || weather === "any") return true;
  const itemTerms = normalized([...(item.seasons || []), ...(item.weatherSuitability || [])]);
  const accepted = WEATHER_TERMS[weather] || [];
  return itemTerms.length === 0 || accepted.some((term) => itemTerms.includes(term));
}

function hasStyleOverlap(item, occasion, vibe) {
  const styles = normalized(item.styleTags);
  const terms = [
    ...(OCCASION_TERMS[occasion] || []),
    ...String(vibe || "")
      .toLowerCase()
      .split(/[,/\s]+/)
      .filter((token) => token.length > 2)
  ];
  return terms.some((term) => styles.some((style) => style.includes(term) || term.includes(style)));
}

/**
 * Produces a locally-filtered, ranked set for the model. It intentionally
 * leaves a little variety instead of hard-removing items with sparse tags.
 */
export function filterWardrobeForOutfit(items, filters = {}, repeatDays = 7) {
  const { weather = "any", occasion = "casual", vibe = "", requiredItemId } = filters;
  const hasWeatherMatches = items.some((item) => itemMatchesWeather(item, weather));

  return items
    .map((item) => {
      const weatherMatch = itemMatchesWeather(item, weather);
      const styleMatch = hasStyleOverlap(item, occasion, vibe);
      const required = item.id === requiredItemId;
      const recent = isRecentlyWorn(item.lastWornDate, repeatDays);
      const score = (required ? 100 : 0) + (weatherMatch ? 16 : 0) + (styleMatch ? 8 : 0) - (recent ? 10 : 0);
      return { ...item, _outfitScore: score, _isRecent: recent, _weatherMatch: weatherMatch };
    })
    .filter((item) => item.id === requiredItemId || !hasWeatherMatches || item._weatherMatch)
    .sort((a, b) => b._outfitScore - a._outfitScore || String(a.category).localeCompare(String(b.category)));
}

export function makeWardrobePromptItems(items, repeatDays = 7) {
  return items.map((item) => ({
    id: item.id,
    category: item.category,
    colors: item.colors || [],
    styleTags: item.styleTags || [],
    seasons: item.seasons || [],
    weatherSuitability: item.weatherSuitability || [],
    notes: item.notes || "",
    lastWornDate: item.lastWornDate || null,
    recentlyWorn: isRecentlyWorn(item.lastWornDate, repeatDays)
  }));
}

export function hasEnoughForSuggestion(items) {
  const categories = new Set(items.map((item) => item.category));
  return categories.has("shoes") && (categories.has("dress") || (categories.has("top") && categories.has("bottom")));
}
