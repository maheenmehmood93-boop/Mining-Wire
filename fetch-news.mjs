// Fetches the RSS/Atom feeds listed in feeds.json and writes data/news.json.
// Only headline, link, date and a short excerpt are stored; readers are sent
// to the original publisher for the full article.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const FEEDS_FILE = new URL("../feeds.json", import.meta.url);
const OUT_FILE = new URL("../data/news.json", import.meta.url);

const MAX_ITEMS = 800; // total kept in the file
const MAX_AGE_DAYS = 35; // older items are dropped (page offers up to 30 days)
const EXCERPT_LEN = 240;
const TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Tagging rules
// ---------------------------------------------------------------------------

const COMMODITIES = {
  Gold: /\bgold\b/i,
  Copper: /\bcopper\b/i,
  Lithium: /\blithium\b/i,
  Silver: /\bsilver\b/i,
  "Iron ore": /\biron ore\b/i,
  Coal: /\b(coal|coking|thermal coal|met coal|lignite)\b/i,
  Nickel: /\bnickel\b/i,
  Uranium: /\buranium\b/i,
  "Rare earths": /\brare earths?\b/i,
  Zinc: /\bzinc\b/i,
  Cobalt: /\bcobalt\b/i,
  Platinum: /\b(platinum|palladium|PGMs?)\b/i,
  Potash: /\b(potash|phosphate|fertili[sz]er)\b/i,
  "Marble & stone": /\b(marble|granite|limestone|gypsum|rock salt)\b/i,
  Gemstones: /\b(gemstones?|emeralds?|rubies|ruby|sapphires?)\b/i,
};

// Place names used to tag stories by province. English names are matched on
// word boundaries; Urdu names are matched as plain substrings.
const PROVINCES = {
  Balochistan: {
    en: /\b(?:balochistan|baluchistan|quetta|chagai|chaghi|dalbandin|nokkundi|saindak|reko\s?-?(?:diq|dik)|gwadar|khuzdar|lasbela|kharan|zhob|loralai|sibi|kalat|turbat|panjgur|awaran|duki|barkhan|harnai|mastung|washuk|chaman|nushki|musakhel|kohlu|jaffarabad|nasirabad|naseerabad|ziarat|pishin|dera bugti|sui|hub chowki)\b/i,
    ur: /بلوچستان|کوئٹہ|چاغی|گوادر|خضدار|ریکوڈک/,
  },
  "Khyber Pakhtunkhwa": {
    en: /\b(?:khyber[\s-]*pakhtunkhwa|pakhtunkhwa|peshawar|swat|chitral|(?:upper|lower)\s+dir|waziristan|mohmand|bajaur|kurram|orakzai|abbottabad|mansehra|kohistan|shangla|buner|malakand|mardan|swabi|nowshera|charsadda|kohat|karak|bannu|lakki marwat|hangu|dera ismail khan|d\.?\s?i\.?\s?khan|haripur|battagram|mingora)\b/i,
    abbr: /\bK-?P-?K?\b(?!\s+Oli)/, // KP, K-P, KPK (case-sensitive)
    ur: /خیبر\s?پختونخوا|پشاور|چترال|سوات|وزیرستان|مہمند|باجوڑ/,
  },
};

// General newspapers are only kept when a story is about mining or minerals.
const MINING_RE = new RegExp(
  [
    "\\b(?:mining|miners?|mines?|minerals?|quarr(?:y|ies)|ores?|lignite|chromite|marble|granite|gemstones?|emeralds?|copper|lithium|antimony|barite|gypsum|limestone|rock salt|salt range|rare earths?|coal|zinc|nickel|cobalt|uranium|bauxite|manganese|tungsten|graphite|potash)\\b",
    "\\breko\\s?-?(?:diq|dik)\\b",
    "\\b(?:saindak|pmdc|barrick|tethyan|mari minerals)\\b",
    "\\bgold\\s+(?:mines?|mining|deposits?|reserves?|projects?|exploration|output|production|licen[cs]es?|belt)\\b",
    "کان کنی|معدنیات|معدنی|کانوں|کوئلہ|کوئلے|تانبا|تانبے|ریکوڈک|ماربل|کرومائٹ|گرینائٹ|قیمتی پتھر",
  ].join("|"),
  "i"
);
// Uses of the word "mining" that have nothing to do with the industry.
const NOT_MINING_RE = /\b(?:bitcoin|crypto(?:currency)?|data|text|digital|blockchain)\s+mining\b|\bmineral water\b/i;

export function isMiningStory(hay) {
  return MINING_RE.test(hay) && !NOT_MINING_RE.test(hay);
}

export function findProvinces(hay, hint) {
  const found = new Set(hint ? [hint] : []);
  for (const [name, r] of Object.entries(PROVINCES)) {
    if (r.en.test(hay) || r.ur.test(hay) || (r.abbr && r.abbr.test(hay))) found.add(name);
  }
  return [...found];
}

export function findCommodities(hay) {
  return Object.entries(COMMODITIES)
    .filter(([, re]) => re.test(hay))
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v == null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8230;/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(raw) {
  const clean = stripHtml(raw)
    .replace(/The post .* appeared first on .*$/i, "")
    .trim();
  if (clean.length <= EXCERPT_LEN) return clean;
  return clean.slice(0, EXCERPT_LEN).replace(/\s+\S*$/, "") + "...";
}

function pickLink(item) {
  if (item.link) {
    const links = asArray(item.link);
    for (const l of links) {
      if (typeof l === "string") return l.trim();
      if (l["@_href"] && (!l["@_rel"] || l["@_rel"] === "alternate")) return l["@_href"];
      if (l["#text"]) return String(l["#text"]).trim();
    }
  }
  if (item.guid && /^https?:/.test(text(item.guid))) return text(item.guid).trim();
  return "";
}

function pickImage(item) {
  const media = asArray(item["media:content"])[0] ?? asArray(item["media:thumbnail"])[0];
  if (media?.["@_url"]) return media["@_url"];
  const enc = asArray(item.enclosure)[0];
  if (enc?.["@_url"] && /image/i.test(enc["@_type"] ?? "image")) return enc["@_url"];
  return null;
}

/**
 * Original publisher named by the feed itself, e.g. <source url="https://...">Reuters</source>
 * (RSS) or an Atom <source><title>..</title></source>. Not every feed provides one.
 */
function pickVia(item) {
  const s = asArray(item.source)[0];
  if (!s) return { via: "", viaUrl: "" };
  const name = stripHtml(typeof s === "object" ? text(s["#text"]) || text(s.title) : String(s));
  let url = typeof s === "object" ? (s["@_url"] ?? asArray(s.link)[0]?.["@_href"] ?? "") : "";
  if (!/^https?:\/\//i.test(url)) url = "";
  return { via: name, viaUrl: url };
}

/** Parses feed XML. Returns the stories worth keeping plus how many were seen. */
export function parseFeedXml(xml, feed) {
  const doc = parser.parse(xml);

  const rssItems = asArray(doc?.rss?.channel?.item);
  const atomItems = asArray(doc?.feed?.entry);
  const rdfItems = asArray(doc?.["rdf:RDF"]?.item);
  const raw = [...rssItems, ...atomItems, ...rdfItems];
  if (raw.length === 0) throw new Error("no items found in feed");

  const all = raw
    .map((item) => {
      const title = stripHtml(text(item.title));
      const link = pickLink(item);
      const dateStr =
        text(item.pubDate) || text(item.published) || text(item.updated) || text(item["dc:date"]);
      const date = dateStr ? new Date(dateStr) : null;
      const summary = excerpt(
        text(item.description) || text(item.summary) || text(item["content:encoded"]) || text(item.content)
      );
      const hay = `${title} ${summary}`;
      const { via, viaUrl } = pickVia(item);
      // Only worth showing when the feed credits someone other than itself.
      const credited = via && via.toLowerCase() !== feed.name.toLowerCase();
      return {
        title,
        link,
        via: credited ? via : "",
        viaUrl: credited ? viaUrl : "",
        date: date && !isNaN(date) ? date.toISOString() : null,
        summary,
        image: pickImage(item),
        source: feed.name,
        section: feed.section ?? "",
        scope: feed.scope ?? "International",
        region: feed.region ?? "",
        provinces: findProvinces(hay, feed.province),
        tags: findCommodities(hay),
        _relevant: feed.filter === "mining" ? isMiningStory(hay) : true,
      };
    })
    .filter((i) => i.title && i.link);

  const items = all.filter((i) => i._relevant).map(({ _relevant, ...rest }) => rest);
  return { items, total: all.length };
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "User-Agent": "MiningNewsAggregator/1.0 (+RSS reader; headline links only)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeedXml(await res.text(), feed);
}

// ---------------------------------------------------------------------------
// Merging and output
// ---------------------------------------------------------------------------

const linkKey = (link) => link.replace(/[?#].*$/, "").replace(/\/+$/, "");
const union = (a = [], b = []) => [...new Set([...a, ...b])];

/** Combines earlier results with fresh ones; drops sources no longer in feeds.json. */
export function mergeItems(previous, fresh, sourceNames, now = Date.now()) {
  const byLink = new Map();
  const normalize = (i) => ({
    section: "",
    scope: "International",
    provinces: [],
    tags: [],
    ...i,
  });

  for (const item of previous.filter((p) => sourceNames.has(p.source)).map(normalize)) {
    byLink.set(linkKey(item.link), item);
  }
  for (const item of fresh) {
    const key = linkKey(item.link);
    const old = byLink.get(key);
    byLink.set(
      key,
      old
        ? { ...old, ...item, provinces: union(old.provinces, item.provinces), tags: union(old.tags, item.tags) }
        : item
    );
  }

  const cutoff = now - MAX_AGE_DAYS * 86400000;
  const nowIso = new Date(now).toISOString();
  return [...byLink.values()]
    .map((i) => {
      // Missing dates, or dates in the future (bad feed timezone), count as "now".
      const t = i.date ? new Date(i.date).getTime() : NaN;
      return { ...i, date: isNaN(t) || t > now + 86400000 ? nowIso : i.date };
    })
    .filter((i) => new Date(i.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);
}

async function loadPrevious() {
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, "utf8"));
    return Array.isArray(prev.items) ? prev.items : [];
  } catch {
    return [];
  }
}

async function main() {
  const feeds = JSON.parse(await readFile(FEEDS_FILE, "utf8"));
  const previous = await loadPrevious();

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const status = [];
  const fresh = [];

  results.forEach((r, i) => {
    const f = feeds[i];
    const label = f.section ? `${f.name} (${f.section})` : f.name;
    if (r.status === "fulfilled") {
      fresh.push(...r.value.items);
      status.push({ source: f.name, section: f.section ?? "", ok: true, items: r.value.items.length, seen: r.value.total });
      console.log(`ok    ${label}: kept ${r.value.items.length} of ${r.value.total}`);
    } else {
      status.push({ source: f.name, section: f.section ?? "", ok: false, error: String(r.reason?.message ?? r.reason) });
      console.warn(`FAIL  ${label}: ${r.reason?.message ?? r.reason}`);
    }
  });

  const items = mergeItems(previous, fresh, new Set(feeds.map((f) => f.name)));

  if (items.length === 0) {
    console.error("No items collected; leaving existing data file untouched.");
    process.exit(1);
  }

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(
    OUT_FILE,
    JSON.stringify({ updated: new Date().toISOString(), sources: status, items }, null, 1)
  );
  console.log(`\nWrote ${items.length} items from ${status.filter((s) => s.ok).length}/${feeds.length} feeds.`);
}

// Run only when executed directly (so tests can import the helpers).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
