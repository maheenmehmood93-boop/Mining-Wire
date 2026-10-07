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
//
// Two tiers keep everyday words from slipping through:
//  - STRONG terms are clearly about the industry and qualify a story on their own.
//  - WEAK terms (a metal, a stone, "minerals") are also used in health, building
//    and technology news, so they only count when the story also uses a word from
//    the context list (deposits, reserves, exploration, licence, exports ...).
// Avoid bare acronyms: "PMDC" is both the Pakistan Mineral Development Corporation
// and the Pakistan Medical and Dental Council, so only the full name is listed.
const STRONG_MINING_RE = new RegExp(
  [
    "\\b(?:mining|miners?|mines?|quarr(?:y|ies)|ores?|lignite|chromite)\\b",
    "\\bminerals?\\s+(?:resources?|policy|policies|sector|exploration|deposits?|wealth|development|act|rules|licen[cs]es?|concessions?|reserves?|potential|projects?)\\b",
    "\\b(?:mines\\s+and\\s+minerals?|critical\\s+minerals?|rare\\s+earths?)\\b",
    "\\bthar\\s+coal\\b",
    "\\bcoal\\s+(?:mines?|mining|fields?|reserves?|deposits?|production|output)\\b",
    "\\breko\\s?-?(?:diq|dik)\\b",
    "\\b(?:saindak|barrick|tethyan|mari minerals|pakistan mineral development corporation)\\b",
    "\\bgold\\s+(?:mines?|mining|deposits?|reserves?|projects?|exploration|output|production|licen[cs]es?|belt)\\b",
    "کان کنی|معدنیات|معدنی|کانوں|کوئلہ|کوئلے|تانبا|تانبے|ریکوڈک|ماربل|کرومائٹ|گرینائٹ|قیمتی پتھر",
  ].join("|"),
  "i"
);
const WEAK_MINING_RE =
  /\b(?:copper|lithium|zinc|nickel|cobalt|uranium|manganese|tungsten|graphite|potash|bauxite|antimony|barite|gypsum|limestone|rock salt|salt range|marble|granite|gemstones?|emeralds?|coal|minerals?)\b/i;
const MINING_CONTEXT_RE =
  /\b(?:deposits?|reserves?|exploration|extraction|licen[cs]es?|leases?|concessions?|smelters?|concentrates?|exports?|royalt(?:y|ies)|geolog\w*|auctions?|tenders?)\b/i;
// Uses of the word "mining" that have nothing to do with the industry.
const NOT_MINING_RE = /\b(?:bitcoin|crypto(?:currency)?|data|text|digital|blockchain)\s+mining\b|\bmineral water\b/i;

export function isMiningStory(hay) {
  if (NOT_MINING_RE.test(hay)) return false;
  return STRONG_MINING_RE.test(hay) || (WEAK_MINING_RE.test(hay) && MINING_CONTEXT_RE.test(hay));
}

// Chagai security tab. A story belongs there only when it names a place in
// Chagai district AND uses a security word, so a headline about Reko Diq
// financing or a Quetta traffic story never shows up on it.
const CHAGAI_RE = new RegExp(
  [
    "\\b(?:chagai|chaghi|chagi|dalbandin|nokkundi|nok\\s?kundi|taftan|saindak|reko\\s?-?(?:diq|dik)|ras\\s?koh|padag|amuri)\\b",
    "چاغی|دالبندین|نوکنڈی|تفتان|سیندک|ریکوڈک|راس\\s?کوہ",
  ].join("|"),
  "i"
);
const SECURITY_RE = new RegExp(
  [
    "\\b(?:attacks?|attacked|terror\\w*|militants?|insurgen\\w*|separatists?|gunmen|gunmans?|firing|gunfire|shootout|encounter|ambush\\w*)\\b",
    "\\b(?:blasts?|explosions?|explosive|bombs?|bombing|ieds?|suicide|landmines?|rockets?|drones?)\\b",
    "\\b(?:kidnap\\w*|abduct\\w*|hostages?|killed|martyred|shaheed|injured|wounded|casualt\\w*)\\b",
    "\\b(?:security|frontier corps|levies|police|ctd|ispr|army|military|operation|curfew|section 144|law and order|clash\\w*|protest\\w*|sit-?in|strike|blockade|road blocked|highway blocked)\\b",
    "\\b(?:iran border|border (?:crossing|closure|closed|clash)|smuggl\\w*)\\b",
    "دہشت|حملہ|حملے|دھماکہ|دھماکے|شہید|فائرنگ|سیکیورٹی|سکیورٹی|اغوا|مسلح|کرفیو|لیویز|پولیس",
  ].join("|"),
  "i"
);
const FC_RE = /\bFC\b/; // "FC" in capitals only (Frontier Corps)

export function isChagaiSecurity(hay) {
  return CHAGAI_RE.test(hay) && (SECURITY_RE.test(hay) || FC_RE.test(hay));
}

// Safety incidents tab ------------------------------------------------------
// Each story gets at most one type; the first matching entry wins, so specific
// events (collapse, tailings) take priority over the general "fatality" bucket.
const SAFETY_TYPES = [
  ["Collapse / cave-in", /\b(?:collaps\w*|cave[- ]?ins?|caved in|trapped|rock ?falls?|roof falls?|landslides?|mudslides?|slope failure|buried|entombed)\b/i],
  ["Tailings / dam failure", /\b(?:tailings|dam (?:failure|collapse|breach|burst))\b/i],
  ["Explosion / fire", /\b(?:explosions?|exploded|blasts?|methane|mine fire|underground fire|caught fire|blaze|fire (?:broke|at|in))\b/i],
  ["Flooding", /\b(?:flood\w*|inundat\w*|water ingress)\b/i],
  ["Gas / ventilation", /\b(?:gas leak|toxic gas|poisonous gas|carbon monoxide|asphyxia\w*|suffocat\w*|ventilation)\b/i],
  ["Vehicle / equipment", /\b(?:haul truck|dump truck|truck|vehicle|conveyor|crane|machinery|helicopter crash|shaft accident|cage accident|winder)\b/i],
  ["Fatality / injury", /\b(?:fatal\w*|killed|dead|died|deaths?|dies|lost (?:his|her|their) li(?:fe|ves)|injur\w*|missing miners?|miners? (?:missing|killed|died)|bodies recovered|worker death)\b/i],
  ["Safety alert / enforcement", /\b(?:safety (?:alerts?|notices?|warnings?|probe|investigation|lapses?|breach\w*|violations?|inspections?|audits?|shutdown)|stop[- ]work|suspend(?:s|ed)? (?:operations|mining|work)|shut(?:s)? down|closure order|prohibition (?:order|notice)|fined|inspector of mines|msha|mine safety (?:regulator|inspection|audit|probe|investigation|breach))\b/i],
];
// Awards, conferences and product news that use the same words.
const NOT_SAFETY_RE = /\b(?:awards?|prizes?|webinar|conference|sponsor\w*|landslide (?:victory|win)|record low|improv\w+ (?:safety|record))\b/i;

// Words like "truck" or "blast" are routine in mining news, so every type except
// the alert/enforcement one also needs a word that says something went wrong.
const INCIDENT_RE =
  /\b(?:accidents?|incidents?|fatal\w*|killed|dead|died|deaths?|dies|injur\w*|trap(?:s|ped)|missing|collaps\w*|cave[- ]?ins?|disaster|tragedy|tragic|rescue[ds]?|evacuat\w*|fire|explosions?|exploded|spill\w*|failure|breach\w*|burst|buried|buries|landslides?|mudslides?|lost (?:his|her|their) li(?:fe|ves))\b/i;

export function findSafetyType(hay) {
  if (NOT_SAFETY_RE.test(hay)) return "";
  const wentWrong = INCIDENT_RE.test(hay);
  for (const [type, re] of SAFETY_TYPES) {
    if (re.test(hay) && (wentWrong || type === "Safety alert / enforcement")) return type;
  }
  return "";
}

// Country is taken from the earliest place named in the headline or excerpt.
const COUNTRIES = [
  ["Pakistan", new RegExp(`\\b(?:pakistan\\w*|punjab|sindh|karachi|lahore|islamabad|rawalpindi)\\b|${PROVINCES.Balochistan.en.source}|${PROVINCES["Khyber Pakhtunkhwa"].en.source}|${PROVINCES.Balochistan.ur.source}|${PROVINCES["Khyber Pakhtunkhwa"].ur.source}`, "i")],
  ["China", /\b(?:china|chinese|shanxi|inner mongolia|guizhou|sichuan|yunnan|henan|xinjiang|shaanxi|guangxi)\b/i],
  ["India", /\b(?:india\w*|jharkhand|odisha|chhattisgarh|meghalaya|dhanbad|assam|rajasthan|telangana)\b/i],
  ["Indonesia", /\b(?:indonesia\w*|sulawesi|kalimantan|sumatra|papua(?! new))\b/i],
  ["Philippines", /\b(?:philippines?|filipino|mindanao|benguet)\b/i],
  ["Bangladesh", /\bbangladesh\w*\b/i],
  ["Nepal", /\bnepal\w*\b/i],
  ["Afghanistan", /\bafghan\w*\b/i],
  ["Iran", /\b(?:iran|iranian|tabas|kerman)\b/i],
  ["Turkey", /\b(?:turkey|t[uü]rkiye|turkish|soma|amasra|[iİ]liç)\b/i],
  ["Kazakhstan", /\bkazakh\w*\b/i],
  ["Mongolia", /\bmongolia\w*\b/i],
  ["Russia", /\b(?:russia\w*|siberia\w*|kemerovo|kuzbass)\b/i],
  ["Ukraine", /\bukrain\w*\b/i],
  ["Poland", /\b(?:poland|polish|silesia\w*)\b/i],
  ["Serbia", /\bserbia\w*\b/i],
  ["Myanmar", /\b(?:myanmar|burma|burmese|hpakant)\b/i],
  ["Vietnam", /\bvietnam\w*\b/i],
  ["Laos", /\blaos\b|\blao\b/i],
  ["Papua New Guinea", /\bpapua new guinea\b|\bPNG\b/i],
  ["Australia", /\b(?:australia\w*|queensland|new south wales|nsw|pilbara|hunter valley|tasmania|kalgoorlie|yilgarn|murchison|gascoyne|gawler|lachlan|northern territory)\b/i],
  ["Canada", /\b(?:canad\w*|ontario|qu[eé]bec|british columbia|saskatchewan|alberta|sudbury|nunavut|yukon|manitoba|newfoundland|labrador|new brunswick|nova scotia|northwest territories|abitibi|timmins|red lake|flin flon|val-d.or|yellowknife|james bay|thunder bay)\b/i],
  ["United States", /\b(?:united states|u\.s\.a?\.?|usa|american|alaska|nevada|arizona|utah|wyoming|montana|idaho|colorado|california|oregon|new mexico|south dakota|minnesota|michigan|west virginia|kentucky|appalachia\w*|msha)\b/i],
  ["Mexico", /\b(?:mexic\w*|sonora|coahuila|zacatecas)\b/i],
  ["Peru", /\bperu\w*\b/i],
  ["Chile", /\b(?:chile\w*|el teniente|escondida|antofagasta)\b/i],
  ["Colombia", /\bcolombia\w*\b/i],
  ["Bolivia", /\bbolivia\w*\b/i],
  ["Brazil", /\b(?:brazil\w*|minas gerais|par[aá] state|carajas)\b/i],
  ["Argentina", /\bargentin\w*\b/i],
  ["Ecuador", /\becuador\w*\b/i],
  ["Venezuela", /\bvenezuela\w*\b/i],
  ["South Africa", /\b(?:south africa\w*|gauteng|rustenburg|johannesburg|witwatersrand|limpopo|mpumalanga|northern cape|north west province|zandspruit)\b/i],
  ["Zimbabwe", /\bzimbabwe\w*\b/i],
  ["Zambia", /\bzambia\w*\b/i],
  ["DR Congo", /\b(?:drc|dr congo|d\.r\. congo|democratic republic of (?:the )?congo|congo|katanga|kolwezi|lualaba|kinshasa)\b/i],
  ["Tanzania", /\btanzania\w*\b/i],
  ["Kenya", /\bkenya\w*\b/i],
  ["Uganda", /\buganda\w*\b/i],
  ["Ghana", /\bghana\w*\b/i],
  ["Mali", /\bmali\b/i],
  ["Burkina Faso", /\bburkina\b/i],
  ["Niger", /\bniger\b/i],
  ["Nigeria", /\bnigeria\w*\b/i],
  ["Guinea", /(?<!(?:new|equatorial)\s)\bguinea\b/i],
  ["Ivory Coast", /\b(?:ivory coast|c[oô]te d.ivoire|ivorian)\b/i],
  ["Sudan", /(?<!south\s)\bsudan\w*\b/i],
  ["Morocco", /\bmorocc\w*\b/i],
  ["Saudi Arabia", /\bsaudi\b/i],
  ["Spain", /\bspain\b|\bspanish\b/i],
  ["Sweden", /\bsweden\b|\bswedish\b/i],
  ["Finland", /\bfinland\b|\bfinnish\b/i],
];

export function findCountry(hay, scope) {
  let best = "";
  let bestAt = Infinity;
  for (const [name, re] of COUNTRIES) {
    const m = re.exec(hay);
    if (m && m.index < bestAt) { best = name; bestAt = m.index; }
  }
  if (best) return best;
  return scope === "National" ? "Pakistan" : "Unspecified";
}

// Exploration results tab -------------------------------------------------
// A story qualifies when it is about copper, gold or lithium, announces a result
// of exploration (drill results, a discovery, a resource estimate, a drilling
// update) and uses project-level language.
const EX_METALS = [
  ["Copper", /\bcopper\b/i, /\b(?:Cu|CuEq)\b/],
  ["Gold", /\bgold\b/i, /\b(?:Au|AuEq)\b/],
  ["Lithium", /\b(?:lithium|spodumene)\b/i, /\b(?:Li2O|LCE)\b/],
];
const EX_TYPES = [
  ["Discovery", /\b(?:new discovery|discover(?:s|ed|y|ies)|greenfield discovery)\b/i],
  ["Resource estimate", /\b(?:(?:maiden |updated |initial |new )?mineral resource(?: estimate| update| upgrade)?s?|resource (?:estimate|update|upgrade)|MRE)\b/i],
  ["Drill results", /\b(?:drill(?:ing|hole)? results?|drill holes?|intersect(?:s|ed|ing)?|intercepts?|assay results?|assays|step-?out|infill (?:drilling|results)|returns? (?:\d|high-?grade))\b/i],
  ["Drilling update", /\b(?:(?:commences?|begins?|starts?|launch\w*|completes?|completed|initiates?|mobili[sz]\w*|resumes?|expands?)\s+(?:\w+\s+){0,3}(?:drill(?:ing)?|exploration)|drill(?:ing)? (?:program(?:me)?|campaign|update)|exploration update)\b/i],
];
const EX_CONTEXT_RE =
  /\b(?:projects?|propert(?:y|ies)|prospects?|deposits?|zones?|veins?|targets?|minerali[sz]ation|drill\w*|exploration|g\/t|gpt|assays?|lode|porphyry|tenure|claims?|licen[cs]es?|tenements?|resource)\b/i;
// "52 m @ 1.25 g/t Au", "78.5 metres grading 0.8% copper", "1.5% Li2O over 30 m"
const GRADE_A = /(\d[\d,]*(?:\.\d+)?)\s*(?:m|metres?|meters?)\b\s*(?:@|at|of|grading|averaging|containing|with)\s*(\d+(?:\.\d+)?)\s*(g\/t|gpt|%|ppm)\s*([A-Za-z][A-Za-z0-9]{1,5})?/i;
const GRADE_B = /(\d+(?:\.\d+)?)\s*(g\/t|gpt|%)\s*([A-Za-z][A-Za-z0-9]{1,5})?\s+over\s+(\d[\d,]*(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/i;
const METAL_WORDS = { gold: "Au", copper: "Cu", lithium: "Li" };

function tidyGrade(len, grade, unit, metal) {
  const u = unit.toLowerCase() === "gpt" ? "g/t" : unit;
  let m = metal ?? "";
  if (/^(?:and|with|of|over|at|from|in|to|the)$/i.test(m)) m = "";
  m = METAL_WORDS[m.toLowerCase()] ?? m;
  return `${len.replace(/,/g, "")} m @ ${grade}${u === "%" ? "%" : " " + u}${m ? " " + m : ""}`;
}

export function findExploration(hay) {
  const metals = EX_METALS.filter(([, ci, cs]) => ci.test(hay) || cs.test(hay)).map(([n]) => n);
  if (!metals.length || !EX_CONTEXT_RE.test(hay)) return null;
  const grade = GRADE_A.exec(hay) ?? GRADE_B.exec(hay);
  let type = "";
  for (const [name, re] of EX_TYPES) if (re.test(hay)) { type = name; break; }
  if (!type && grade) type = "Drill results";
  if (!type) return null;
  let highlight = "";
  if (grade) {
    const a = GRADE_A.exec(hay);
    highlight = a ? tidyGrade(a[1], a[2], a[3], a[4]) : tidyGrade(grade[4], grade[1], grade[2], grade[3]);
  }
  return { type, metals, highlight };
}

const SUBREGIONS = [
  "Ontario", "Quebec", "British Columbia", "Yukon", "Nunavut", "Newfoundland and Labrador", "Saskatchewan", "Manitoba", "Northwest Territories",
  "Nevada", "Arizona", "Alaska", "Utah", "Idaho", "Montana", "Wyoming", "Colorado", "California",
  "Western Australia", "Queensland", "New South Wales", "South Australia", "Tasmania", "Northern Territory",
].map((n) => [n, new RegExp(`\\b${n.replace("Newfoundland and Labrador", "Newfoundland").replace(/ /g, "\\s+")}\\b`, "i")]);

export function findRegion(hay) {
  for (const [name, re] of SUBREGIONS) if (re.test(hay)) return name;
  return "";
}

/**
 * mining: shown in the main mining feed. General newspapers are only "mining"
 * when the story passes the mining check.
 * chagaiSecurity: shown on the Chagai security tab.
 */
export function classifyStory(hay, filter, scope = "International") {
  // "exploration" feeds (press-release wires) are only used for the exploration tab.
  const mining = filter === "mining" ? isMiningStory(hay) : filter === "exploration" ? false : true;
  const ex = findExploration(hay);
  // Mining publications are all about mining, so an incident word is enough;
  // general newspapers must also pass the mining check.
  const safetyType = mining ? findSafetyType(hay) : "";
  return {
    mining,
    chagaiSecurity: isChagaiSecurity(hay),
    safetyType,
    country: safetyType ? findCountry(hay, scope) : "",
    exType: ex?.type ?? "",
    exMetals: ex?.metals ?? [],
    exHighlight: ex?.highlight ?? "",
    exCountry: ex ? findCountry(hay, "International") : "",
    exRegion: ex ? findRegion(hay) : "",
  };
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
  // The default limit (1,000 entity references per file) is meant to stop
  // malicious files, but large news feeds (Dawn, Business Recorder) exceed it
  // with ordinary &amp; and &#8217; characters. Raise it, keeping nesting shallow.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 100000,
    maxExpandedLength: 5000000,
    maxExpansionDepth: 10,
  },
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
        ...classifyStory(hay, feed.filter, feed.scope),
        press: feed.kind === "press",
      };
    })
    .filter((i) => i.title && i.link);

  const items = all.filter((i) => i.mining || i.chagaiSecurity || i.exType);
  return { items, total: all.length };
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      // Plain, honest feed-reader identity. Some sites reject unfamiliar agent
      // strings that don't start with the usual "Mozilla/5.0 (compatible; ...)".
      "User-Agent": "Mozilla/5.0 (compatible; MiningWire/1.0; +https://github.com/maheenmehmood93-boop/Mining-Wire)",
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
export function mergeItems(previous, fresh, sourceNames, now = Date.now(), keepPrevious = () => true) {
  const byLink = new Map();
  const normalize = (i) => ({
    section: "",
    scope: "International",
    provinces: [],
    tags: [],
    mining: true,
    chagaiSecurity: false,
    safetyType: "",
    country: "",
    exType: "",
    exMetals: [],
    exHighlight: "",
    exCountry: "",
    exRegion: "",
    ...i,
  });

  for (const item of previous.filter((p) => sourceNames.has(p.source) && keepPrevious(p)).map(normalize)) {
    byLink.set(linkKey(item.link), item);
  }
  for (const item of fresh) {
    const key = linkKey(item.link);
    const old = byLink.get(key);
    byLink.set(
      key,
      old
        ? {
            ...old,
            ...item,
            provinces: union(old.provinces, item.provinces),
            tags: union(old.tags, item.tags),
            mining: old.mining || item.mining,
            chagaiSecurity: old.chagaiSecurity || item.chagaiSecurity,
            safetyType: item.safetyType || old.safetyType,
            country: item.country || old.country,
            ...(item.exType ? {} : { exType: old.exType, exMetals: old.exMetals, exHighlight: old.exHighlight, exCountry: old.exCountry, exRegion: old.exRegion }),
            press: item.press || old.press,
          }
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

  // Stories saved by earlier runs are checked again against the current rules,
  // so a keyword fix also removes stories that were wrongly kept before.
  const filtersByName = new Map();
  feeds.forEach((f) => filtersByName.set(f.name, [...(filtersByName.get(f.name) ?? []), f.filter]));
  // A source is "mining" / "exploration" only when every feed under that name is.
  const filterOf = (name) => {
    const all = filtersByName.get(name) ?? [];
    return all.length && all.every((f) => f === "mining") ? "mining" : all.length && all.every((f) => f === "exploration") ? "exploration" : "none";
  };
  const reviewed = previous.map((i) => ({
    ...i,
    ...classifyStory(`${i.title} ${i.summary ?? ""}`, filterOf(i.source), i.scope),
  }));
  const keepPrevious = (i) => i.mining || i.chagaiSecurity || i.exType;

  const items = mergeItems(reviewed, fresh, new Set(feeds.map((f) => f.name)), Date.now(), keepPrevious);

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
