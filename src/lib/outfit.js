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

  return items
    .map((item) => {
      const weatherMatch = itemMatchesWeather(item, weather);
      const styleMatch = hasStyleOverlap(item, occasion, vibe);
      const required = item.id === requiredItemId;
      const recent = isRecentlyWorn(item.lastWornDate, repeatDays);
      const score = (required ? 100 : 0) + (weatherMatch ? 16 : 0) + (styleMatch ? 8 : 0) - (recent ? 10 : 0);
      return { ...item, _outfitScore: score, _isRecent: recent, _weatherMatch: weatherMatch };
    })
    // Weather ranks, it never eliminates. Dropping every non-matching piece used
    // to wipe out whole categories — tag a top "summer" then ask for a cool day
    // and it vanished, leaving nothing to build an outfit from. The +16 score
    // above already floats weather-appropriate pieces to the front of their
    // category, and the prompt tells the model the weather anyway.
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

/**
 * Picks one outfit at random from the wardrobe, weighted the same way
 * filterWardrobeForOutfit already ranks (weather/style match, not worn
 * recently) but not deterministic — repeated shuffles give different
 * results. Needs no AI and no API key: research on competing apps found
 * every one of them has an AI outfit suggestion users don't fully trust, but
 * a reliable, always-available shuffle is consistently well liked.
 */
export function shuffleOutfit(items, filters = {}, repeatDays = 7) {
  const ranked = filterWardrobeForOutfit(items, filters, repeatDays);
  const byCategory = new Map();
  ranked.forEach((item) => {
    const bucket = byCategory.get(item.category) || [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  });

  const wantedItem = filters.requiredItemId
    ? ranked.find((item) => item.id === filters.requiredItemId)
    : null;

  const pickFrom = (category, { chance = 1 } = {}) => {
    if (wantedItem?.category === category) return wantedItem;
    const bucket = byCategory.get(category);
    if (!bucket?.length || Math.random() > chance) return null;
    // Randomise among the top half of the ranked bucket, not just its single
    // best item, so repeated taps actually vary while still favouring
    // weather/style-appropriate, not-recently-worn pieces.
    // Math.ceil(length / 2) alone gives 1 for a two-item bucket, which would
    // always pick the same #1-ranked item and defeat the whole point of a
    // shuffle. At least 2 candidates are eligible whenever at least 2 exist.
    const poolSize = bucket.length <= 1 ? bucket.length : Math.max(2, Math.ceil(bucket.length / 2));
    return bucket[Math.floor(Math.random() * poolSize)];
  };

  const hasDresses = (byCategory.get('dress')?.length || 0) > 0;
  const hasTopAndBottom = (byCategory.get('top')?.length || 0) > 0 && (byCategory.get('bottom')?.length || 0) > 0;
  const useDress = wantedItem
    ? wantedItem.category === 'dress'
    : hasDresses && (!hasTopAndBottom || Math.random() < 0.5);

  const selected = useDress
    ? [pickFrom('dress'), pickFrom('shoes'), pickFrom('outerwear', { chance: 0.4 }), pickFrom('accessory', { chance: 0.3 })]
    : [pickFrom('top'), pickFrom('bottom'), pickFrom('shoes'), pickFrom('outerwear', { chance: 0.4 }), pickFrom('accessory', { chance: 0.3 })];

  const outfit = selected.filter(Boolean);

  return {
    itemIds: outfit.map((item) => item.id),
    explanation: outfit.length
      ? 'Shuffled from your wardrobe — tap again for a different combination.'
      : 'Add a few more pieces so there is something to shuffle.',
  };
}

/**
 * Aggregates wardrobe items against their outfit-record history for the
 * Stats screen: what actually gets worn, what doesn't, and — only when a
 * price was entered — cost-per-wear. Pure and derived from the records
 * rather than a cached count, so it can never drift out of sync with them.
 */
export function computeWardrobeStats(items, outfitRecords = []) {
  const wornCounts = new Map();
  outfitRecords
    .filter((record) => record.status === 'worn')
    .forEach((record) => {
      record.itemIds.forEach((id) => wornCounts.set(id, (wornCounts.get(id) || 0) + 1));
    });

  const withCounts = items.map((item) => {
    const wornCount = wornCounts.get(item.id) || 0;
    return {
      item,
      wornCount,
      // Guarded explicitly: an unworn item with a price would otherwise
      // divide by zero and show Infinity instead of nothing.
      costPerWear: item.pricePaid && wornCount ? item.pricePaid / wornCount : null,
    };
  });

  const everWorn = [...withCounts.filter((entry) => entry.wornCount > 0)]
    .sort((a, b) => b.wornCount - a.wornCount);

  const byCategory = new Map();
  items.forEach((item) => {
    byCategory.set(item.category, (byCategory.get(item.category) || 0) + 1);
  });

  return {
    totalItems: items.length,
    totalWornOutfits: outfitRecords.filter((record) => record.status === 'worn').length,
    mostWorn: everWorn.slice(0, 5),
    leastWorn: everWorn.slice(-5).reverse(),
    neverWorn: withCounts.filter((entry) => entry.wornCount === 0).map((entry) => entry.item),
    categoryBreakdown: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
    costPerWear: withCounts
      .filter((entry) => entry.costPerWear !== null)
      .sort((a, b) => b.costPerWear - a.costPerWear),
  };
}

/**
 * Advisory only — never gates the Outfit tab. Names what a complete outfit is
 * still missing (e.g. no shoes yet) so the suggestion screen can say so, rather
 * than the wardrobe silently blocking the whole feature until every category
 * is filled in.
 */
export function missingForCompleteOutfit(items) {
  const categories = new Set(items.map((item) => item.category));
  const missing = [];

  if (!categories.has("shoes")) missing.push("shoes");
  if (!categories.has("dress") && !(categories.has("top") && categories.has("bottom"))) {
    if (!categories.has("top")) missing.push("a top");
    if (!categories.has("bottom")) missing.push("a bottom");
  }

  return missing;
}
