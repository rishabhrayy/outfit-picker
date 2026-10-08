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

/** False for a piece marked as in the wash, at the cleaner's, being repaired or away. */
export function isAvailable(item) {
  return !item?.unavailable;
}

/** An order-independent key for two items, so "A with B" and "B with A" match. */
export function pairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

/**
 * The two pieces that define an outfit for feedback purposes: the top and
 * bottom, or the dress and shoes. "Never suggest this again" rules out that
 * pairing rather than the exact set, so swapping the socks doesn't bring a
 * combination back, and an innocent pair of shoes isn't banned with it.
 */
export function corePair(itemIds, itemsById) {
  const pieces = itemIds.map((id) => itemsById.get(id)).filter(Boolean);
  const find = (category) => pieces.find((item) => item.category === category);
  const top = find("top");
  const bottom = find("bottom");
  if (top && bottom) return pairKey(top.id, bottom.id);
  const dress = find("dress");
  const shoes = find("shoes");
  if (dress && shoes) return pairKey(dress.id, shoes.id);
  return null;
}

/**
 * Turns "love it" and "never suggest this again" records into what the
 * suggestion logic uses: pairs to avoid, and how often each piece was in a
 * loved outfit. Derived from the records every time, so deleting a record in
 * the journal undoes its effect immediately.
 */
export function deriveFeedback(outfitRecords = [], items = []) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const blockedPairs = new Set();
  const lovedCounts = new Map();
  const lovedOutfits = [];

  outfitRecords.forEach((record) => {
    if (record.status === "rejected") {
      const key = corePair(record.itemIds, itemsById);
      if (key) blockedPairs.add(key);
    } else if (record.status === "loved") {
      const present = record.itemIds.filter((id) => itemsById.has(id));
      if (present.length) lovedOutfits.push(present);
      present.forEach((id) => lovedCounts.set(id, (lovedCounts.get(id) || 0) + 1));
    }
  });

  return { blockedPairs, lovedCounts, lovedOutfits };
}

export const EMPTY_FEEDBACK = Object.freeze({ blockedPairs: new Set(), lovedCounts: new Map(), lovedOutfits: [] });

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
  const { weather = "any", occasion = "casual", vibe = "", requiredItemId, rain = false, feedback = EMPTY_FEEDBACK } = filters;

  return items
    // An unavailable piece is never suggested, unless it was asked for by name.
    .filter((item) => isAvailable(item) || item.id === requiredItemId)
    .map((item) => {
      const weatherMatch = itemMatchesWeather(item, weather);
      const styleMatch = hasStyleOverlap(item, occasion, vibe);
      const required = item.id === requiredItemId;
      const recent = isRecentlyWorn(item.lastWornDate, repeatDays);
      const rainMatch = rain && itemMatchesWeather(item, "rainy") && normalized([...(item.seasons || []), ...(item.weatherSuitability || [])]).length > 0;
      // Being in a loved outfit nudges a piece up, capped so a favourite can't
      // crowd out the weather and the occasion.
      const loved = Math.min(8, 4 * (feedback.lovedCounts?.get(item.id) || 0));
      const score = (required ? 100 : 0) + (weatherMatch ? 16 : 0) + (styleMatch ? 8 : 0) + (rainMatch ? 6 : 0) + loved - (recent ? 10 : 0);
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
export function shuffleOutfit(items, filters = {}, repeatDays = 7, random = Math.random) {
  const outfit = assembleOutfit(filterWardrobeForOutfit(items, filters, repeatDays), filters, random);
  return {
    itemIds: outfit.map((item) => item.id),
    explanation: outfit.length
      ? 'Shuffled from your wardrobe — tap again for a different combination.'
      : 'Add a few more pieces so there is something to shuffle.',
  };
}

/**
 * The best-ranked outfit, with no randomness — what's shown when there's no
 * AI provider, or the AI call failed. Same rules as the shuffle: available
 * pieces only, and never a pairing that was ruled out.
 */
export function localOutfit(items, filters = {}, repeatDays = 7) {
  const outfit = assembleOutfit(filterWardrobeForOutfit(items, filters, repeatDays), filters, null);
  return {
    itemIds: outfit.map((item) => item.id),
    explanation: outfit.length
      ? 'A balanced pick from the pieces that best match your answers. Connect an AI provider in Settings for a tailored explanation.'
      : 'Add a few more pieces so I can build a complete outfit.',
  };
}

/** A top and a bottom, or a dress: the minimum that counts as something to wear. */
export function isCompleteOutfit(itemIds, itemsById) {
  const categories = new Set(itemIds.map((id) => itemsById.get(id)?.category));
  return categories.has("dress") || (categories.has("top") && categories.has("bottom"));
}

const COLD_WEATHER = new Set(["cold", "cool"]);

/**
 * Builds one outfit from an already-ranked list. With `random` it varies
 * between calls, choosing among the top half of each category; with
 * `random` null it always takes the best-ranked piece. Either way a pairing
 * in feedback.blockedPairs is avoided whenever any other choice exists.
 */
function assembleOutfit(ranked, filters = {}, random = Math.random) {
  const blocked = filters.feedback?.blockedPairs || EMPTY_FEEDBACK.blockedPairs;
  const isBlocked = (a, b) => Boolean(a && b) && blocked.has(pairKey(a.id, b.id));
  const wanted = filters.requiredItemId ? ranked.find((item) => item.id === filters.requiredItemId) : null;
  const bucket = (category) => (wanted?.category === category ? [wanted] : ranked.filter((item) => item.category === category));

  const choose = (list) => {
    if (!list.length) return null;
    if (!random) return list[0];
    // The top half of the ranking, not just its single best item, so repeated
    // taps vary while still favouring weather/style-appropriate, not recently
    // worn pieces. Math.ceil(length / 2) alone gives 1 for a two-item list,
    // which would always pick the same item, so at least 2 are eligible.
    const poolSize = list.length <= 1 ? list.length : Math.max(2, Math.ceil(list.length / 2));
    return list[Math.floor(random() * poolSize)];
  };

  // The defining pair (top + bottom, or dress + shoes) is chosen together, so
  // a ruled-out combination is skipped rather than retried until it misses.
  const choosePair = (firstCategory, secondCategory) => {
    const firsts = bucket(firstCategory);
    const seconds = bucket(secondCategory);
    if (!firsts.length || !seconds.length) return [choose(firsts), choose(seconds)];
    const viable = firsts.filter((first) => seconds.some((second) => !isBlocked(first, second)));
    // Every combination ruled out: an outfit that repeats one beats no outfit.
    if (!viable.length) return [choose(firsts), choose(seconds)];
    const first = choose(viable);
    return [first, choose(seconds.filter((second) => !isBlocked(first, second)))];
  };

  const hasDresses = bucket("dress").length > 0;
  const hasTopAndBottom = bucket("top").length > 0 && bucket("bottom").length > 0;
  const useDress = wanted && ["dress", "top", "bottom"].includes(wanted.category)
    ? wanted.category === "dress"
    : hasDresses && (!hasTopAndBottom || (random ? random() < 0.5 : false));

  const chilly = COLD_WEATHER.has(filters.weather) || Boolean(filters.rain);
  const optional = (category, chance) => {
    if (wanted?.category === category) return wanted;
    if (random) return random() < chance ? choose(bucket(category)) : null;
    return chance >= 0.5 ? choose(bucket(category)) : null;
  };
  const outerwear = optional("outerwear", chilly ? 0.9 : 0.3);
  const accessory = optional("accessory", 0.3);

  const core = useDress
    ? choosePair("dress", "shoes")
    : [...choosePair("top", "bottom"), choose(bucket("shoes"))];

  return [...core, outerwear, accessory].filter(Boolean);
}

/**
 * Plans one outfit per day, without wearing the same top, bottom or dress
 * twice while there's anything else left to wear (shoes, layers and extras
 * may repeat, as they do in real life). Each day carries its own weather and
 * occasion. Local and instant: seven AI calls would be slow and, on a free
 * tier, likely rate-limited part way through.
 */
export function planOutfitsForDays(items, days, { repeatDays = 7, feedback = EMPTY_FEEDBACK, random = Math.random } = {}) {
  const used = new Set();
  const MAIN = new Set(["top", "bottom", "dress"]);

  return days.map((day) => {
    const filters = {
      weather: day.weather || "any",
      rain: Boolean(day.rain),
      occasion: occasionKey(day.occasion),
      vibe: day.vibe || "",
      feedback,
    };
    // A category whose pieces have all been worn this week starts its rotation
    // again, so day five gets a bottom rather than a top on its own. Checked per
    // category: running out of bottoms doesn't let the tops repeat early.
    MAIN.forEach((category) => {
      const inCategory = items.filter((item) => item.category === category && isAvailable(item));
      if (inCategory.length && inCategory.every((item) => used.has(item.id))) {
        inCategory.forEach((item) => used.delete(item.id));
      }
    });
    const fresh = items.filter((item) => !(MAIN.has(item.category) && used.has(item.id)));
    const outfit = assembleOutfit(filterWardrobeForOutfit(fresh, filters, repeatDays), filters, random);
    outfit.forEach((item) => { if (MAIN.has(item.category)) used.add(item.id); });
    return { ...day, itemIds: outfit.map((item) => item.id) };
  });
}

const NEUTRAL_COLORS = ["black", "white", "grey", "gray", "navy", "beige", "cream", "denim", "khaki", "brown", "tan", "camel", "charcoal", "ivory", "olive", "stone"];

function neutralScore(item) {
  const colors = normalized(item.colors);
  return colors.length && colors.every((color) => NEUTRAL_COLORS.some((neutral) => color.includes(neutral))) ? 6 : 0;
}

/**
 * A trip's packing list and its day-by-day outfits. Packing is the opposite
 * problem to the weekly plan: the fewest pieces that still cover every day,
 * so bottoms and shoes are re-worn and tops rotate, and neutral colours are
 * preferred because they pair with more.
 */
export function packForTrip(items, days, { occasion = "Everyday", feedback = EMPTY_FEEDBACK } = {}) {
  const count = days.length;
  if (!count) return { packingList: [], outfits: [] };

  const tally = new Map();
  days.forEach((day) => tally.set(day.weather || "any", (tally.get(day.weather || "any") || 0) + 1));
  const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const anyRain = days.some((day) => day.rain);
  const needsLayer = anyRain || days.some((day) => COLD_WEATHER.has(day.weather));

  const filters = { weather: dominant, rain: anyRain, occasion: occasionKey(occasion), feedback };
  // Recent wear doesn't matter for a trip, so repeatDays is 0.
  const ranked = filterWardrobeForOutfit(items, filters, 0)
    .map((item) => ({ ...item, _packScore: item._outfitScore + neutralScore(item) }))
    .sort((a, b) => b._packScore - a._packScore);
  const top = (category, howMany) => ranked.filter((item) => item.category === category).slice(0, howMany);

  const blocked = feedback.blockedPairs || EMPTY_FEEDBACK.blockedPairs;
  const isBlocked = (a, b) => blocked.has(pairKey(a.id, b.id));

  const bottoms = top("bottom", Math.max(1, Math.ceil(count / 3)));
  // Tops that pair with at least one packed bottom come first.
  const tops = ranked
    .filter((item) => item.category === "top")
    .sort((a, b) => Number(bottoms.every((bottom) => isBlocked(a, bottom))) - Number(bottoms.every((bottom) => isBlocked(b, bottom))))
    .slice(0, Math.min(count, Math.max(1, Math.ceil(count * 0.7))));
  const useDresses = !(tops.length && bottoms.length);
  const dresses = useDresses ? top("dress", Math.min(count, Math.max(1, Math.ceil(count * 0.7)))) : [];
  const shoes = top("shoes", count > 4 ? 2 : 1);
  const layers = needsLayer ? top("outerwear", 1) : [];

  const outfits = days.map((day, index) => {
    const shoe = shoes.length ? shoes[index % shoes.length] : null;
    const layer = layers.length && (day.rain || COLD_WEATHER.has(day.weather)) ? layers[0] : null;
    let core;
    if (useDresses) {
      core = dresses.length ? [dresses[index % dresses.length]] : [];
    } else {
      const shirt = tops[index % tops.length];
      const rotated = [...bottoms.slice(index % bottoms.length), ...bottoms.slice(0, index % bottoms.length)];
      core = [shirt, rotated.find((bottom) => !isBlocked(shirt, bottom)) || rotated[0]];
    }
    return { ...day, itemIds: [...core, shoe, layer].filter(Boolean).map((item) => item.id) };
  });

  const packedIds = new Set(outfits.flatMap((outfit) => outfit.itemIds));
  return {
    packingList: ranked.filter((item) => packedIds.has(item.id)).map(({ _outfitScore, _isRecent, _weatherMatch, _packScore, ...item }) => item),
    outfits,
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
