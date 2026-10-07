// Collects commodity prices into data/prices.json.
//
//  - Daily: spot gold, silver, platinum and palladium and COMEX copper futures
//    from the free gold-api.com service, one point per day, added to the history
//    kept in data/prices.json (so the daily chart grows over time).
//  - Monthly: averages from the World Bank "Pink Sheet" workbook (copper,
//    aluminium, nickel, zinc, lead, tin, iron ore, Australian coal and the
//    precious metals). It is published once a month.
//
// Not included: the LME (its data pages are licensed and may not be scraped)
// and lithium (no free daily or monthly source exists).
//
// Run with --force to refetch even if today's prices are already stored.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

const OUT_FILE = new URL("../data/prices.json", import.meta.url);
const USER_AGENT = "Mozilla/5.0 (compatible; MiningWire/1.0; +https://github.com/maheenmehmood93-boop/Mining-Wire)";
const TIMEOUT_MS = 30000;
const LB_PER_TONNE = 2204.62262;
const MAX_DAILY_POINTS = 400;
const MONTHS_KEPT = 60;
const PINK_SHEET_PAGE = "https://www.worldbank.org/en/research/commodity-markets";

// symbol = gold-api.com symbol. factor converts the quoted price to `unit`.
export const DAILY = [
  { id: "gold", name: "Gold", symbol: "XAU", unit: "USD/oz", factor: 1, note: "Spot" },
  { id: "silver", name: "Silver", symbol: "XAG", unit: "USD/oz", factor: 1, note: "Spot" },
  { id: "copper", name: "Copper", symbol: "HG", unit: "USD/tonne", factor: LB_PER_TONNE, note: "COMEX futures, converted from USD/lb" },
  { id: "platinum", name: "Platinum", symbol: "XPT", unit: "USD/oz", factor: 1, note: "Spot" },
  { id: "palladium", name: "Palladium", symbol: "XPD", unit: "USD/oz", factor: 1, note: "Spot" },
];

// match = text of the column heading in the Pink Sheet "Monthly Prices" sheet.
export const MONTHLY = [
  { id: "copper", name: "Copper", match: /^copper/i, unit: "USD/tonne" },
  { id: "aluminum", name: "Aluminium", match: /^alumin/i, unit: "USD/tonne" },
  { id: "nickel", name: "Nickel", match: /^nickel/i, unit: "USD/tonne" },
  { id: "zinc", name: "Zinc", match: /^zinc/i, unit: "USD/tonne" },
  { id: "lead", name: "Lead", match: /^lead/i, unit: "USD/tonne" },
  { id: "tin", name: "Tin", match: /^tin/i, unit: "USD/tonne" },
  { id: "iron-ore", name: "Iron ore", match: /^iron ore/i, unit: "USD/dmt" },
  { id: "coal", name: "Coal (Australia)", match: /^coal,?\s*austral/i, unit: "USD/tonne" },
  { id: "gold", name: "Gold", match: /^gold/i, unit: "USD/oz" },
  { id: "silver", name: "Silver", match: /^silver/i, unit: "USD/oz" },
  { id: "platinum", name: "Platinum", match: /^platinum/i, unit: "USD/oz" },
];

// ---------------------------------------------------------------------------
// Daily prices
// ---------------------------------------------------------------------------

/** Turns a gold-api.com reply into { date, price } in the unit of `metal`, or throws. */
export function parseSpot(json, metal) {
  const raw = Number(json?.price);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("no price in reply");
  const stamp = json.updatedAt ? new Date(json.updatedAt) : new Date();
  const date = (isNaN(stamp) ? new Date() : stamp).toISOString().slice(0, 10);
  return { date, price: Math.round(raw * metal.factor * 100) / 100 };
}

/** Adds a point, replacing an earlier one for the same date; keeps the newest MAX_DAILY_POINTS. */
export function addPoint(points = [], date, price, max = MAX_DAILY_POINTS) {
  const rest = points.filter((p) => p[0] !== date);
  return [...rest, [date, price]].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-max);
}

async function getText(url, accept = "*/*") {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: accept },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fetchSpot(metal) {
  const res = await getText(`https://api.gold-api.com/price/${metal.symbol}`, "application/json");
  return parseSpot(await res.json(), metal);
}

// ---------------------------------------------------------------------------
// Monthly prices: World Bank Pink Sheet (.xlsx)
// ---------------------------------------------------------------------------

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false });
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const plain = (v) => {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  // <t> or rich text <r><t>..</t></r> runs
  const runs = arr(v.r).map((r) => plain(r.t));
  return String(v["#text"] ?? "") || plain(v.t) || runs.join("");
};

/** Minimal zip reader (enough for .xlsx files): returns { name: Buffer }. */
export function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip/xlsx file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    files[name] = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Reads one worksheet of an .xlsx into rows of cell values (strings or numbers). */
export function readSheet(buffer, sheetName) {
  const files = unzip(Buffer.from(buffer));
  const read = (name) => (files[name] ? files[name].toString("utf8") : null);

  const wb = xml.parse(read("xl/workbook.xml") ?? "");
  const sheets = arr(wb?.workbook?.sheets?.sheet);
  const sheet = sheets.find((s) => String(s["@_name"]).toLowerCase() === sheetName.toLowerCase());
  if (!sheet) throw new Error(`sheet "${sheetName}" not found (has: ${sheets.map((s) => s["@_name"]).join(", ")})`);

  const rels = xml.parse(read("xl/_rels/workbook.xml.rels") ?? "");
  const rid = sheet["@_r:id"];
  const rel = arr(rels?.Relationships?.Relationship).find((r) => r["@_Id"] === rid);
  if (!rel) throw new Error("sheet relationship not found");
  const target = String(rel["@_Target"]).replace(/^\//, "");
  const path = target.startsWith("xl/") ? target : "xl/" + target;

  const sstXml = read("xl/sharedStrings.xml");
  const strings = sstXml ? arr(xml.parse(sstXml)?.sst?.si).map(plain) : [];

  const doc = xml.parse(read(path) ?? "");
  const rows = [];
  for (const row of arr(doc?.worksheet?.sheetData?.row)) {
    const out = [];
    for (const c of arr(row.c)) {
      const idx = colIndex(String(c["@_r"] ?? "A1"));
      const t = c["@_t"];
      let val;
      if (t === "s") val = strings[Number(c.v)] ?? "";
      else if (t === "inlineStr") val = plain(c.is);
      else if (t === "str") val = String(c.v ?? "");
      else if (c.v != null && c.v !== "") val = Number(c.v);
      else val = "";
      out[idx] = val;
    }
    rows.push(out);
  }
  return rows;
}

/** Extracts monthly series from the Pink Sheet "Monthly Prices" rows. */
export function parsePinkSheet(buffer) {
  const rows = readSheet(buffer, "Monthly Prices");
  const cell = (r, i) => String(r?.[i] ?? "").trim();

  // Heading row = the first row where several commodity names appear.
  let head = -1;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const hits = MONTHLY.filter((m) => (rows[r] ?? []).some((v) => typeof v === "string" && m.match.test(v.trim()))).length;
    if (hits >= 4) { head = r; break; }
  }
  if (head < 0) throw new Error("could not find the commodity heading row");

  const columns = {};
  for (const m of MONTHLY) {
    const i = (rows[head] ?? []).findIndex((v) => typeof v === "string" && m.match.test(v.trim()));
    if (i >= 0) columns[m.id] = i;
  }

  const out = {};
  for (const m of MONTHLY) if (columns[m.id] != null) out[m.id] = [];
  for (let r = head + 1; r < rows.length; r++) {
    const period = /^(\d{4})M(\d{2})$/.exec(cell(rows[r], 0));
    if (!period) continue;
    const month = `${period[1]}-${period[2]}`;
    for (const [id, i] of Object.entries(columns)) {
      const v = rows[r][i];
      if (typeof v === "number" && Number.isFinite(v)) out[id].push([month, Math.round(v * 100) / 100]);
    }
  }
  for (const id of Object.keys(out)) out[id] = out[id].slice(-MONTHS_KEPT);
  if (!Object.values(out).some((p) => p.length)) throw new Error("no monthly values found");
  return out;
}

async function fetchPinkSheet() {
  const page = await (await getText(PINK_SHEET_PAGE, "text/html")).text();
  const m = /https:\/\/thedocs\.worldbank\.org\/en\/doc\/[^"'\s<>]+CMO-Historical-Data-Monthly\.xlsx/i.exec(page);
  if (!m) throw new Error("download link not found on the World Bank page");
  const res = await getText(m[0]);
  return parsePinkSheet(Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const prev = await loadPrevious();
  const today = new Date().toISOString().slice(0, 10);
  const daily = { ...(prev.daily ?? {}) };
  const monthly = { ...(prev.monthly ?? {}) };
  const sources = [];

  const haveToday = DAILY.every((m) => daily[m.id]?.points?.some((p) => p[0] === today));
  if (force || !haveToday) {
    const results = await Promise.allSettled(DAILY.map(fetchSpot));
    results.forEach((r, i) => {
      const m = DAILY[i];
      if (r.status === "fulfilled") {
        daily[m.id] = {
          name: m.name, unit: m.unit, note: m.note, source: "gold-api.com",
          points: addPoint(daily[m.id]?.points, r.value.date, r.value.price),
        };
        console.log(`ok    ${m.name}: ${r.value.price} ${m.unit}`);
      } else {
        console.warn(`FAIL  ${m.name}: ${r.reason?.message ?? r.reason}`);
      }
    });
    const ok = results.filter((r) => r.status === "fulfilled").length;
    sources.push({ name: "gold-api.com (daily)", ok: ok > 0, detail: `${ok} of ${DAILY.length} metals`, error: ok ? "" : String(results[0].reason?.message ?? results[0].reason) });
  } else {
    sources.push(...(prev.sources ?? []).filter((s) => /daily/.test(s.name)));
    console.log("Daily prices already stored for today; use --force to refetch.");
  }

  const ageDays = prev.monthlyFetched ? (Date.now() - new Date(prev.monthlyFetched)) / 86400000 : Infinity;
  let monthlyFetched = prev.monthlyFetched ?? null;
  if (force || ageDays > 6) {
    try {
      const series = await fetchPinkSheet();
      for (const m of MONTHLY) {
        if (series[m.id]?.length) {
          monthly[m.id] = { name: m.name, unit: m.unit, source: "World Bank Pink Sheet (monthly average)", points: series[m.id] };
        }
      }
      monthlyFetched = new Date().toISOString();
      sources.push({ name: "World Bank Pink Sheet (monthly)", ok: true, detail: `${Object.keys(series).length} series`, error: "" });
      console.log(`ok    World Bank Pink Sheet: ${Object.keys(series).length} series`);
    } catch (e) {
      sources.push({ name: "World Bank Pink Sheet (monthly)", ok: false, detail: "", error: String(e.message ?? e) });
      console.warn(`FAIL  World Bank Pink Sheet: ${e.message ?? e}`);
    }
  } else {
    sources.push(...(prev.sources ?? []).filter((s) => /monthly/.test(s.name)));
  }

  if (!Object.keys(daily).length && !Object.keys(monthly).length) {
    console.error("No prices collected; leaving existing data file untouched.");
    process.exit(1);
  }

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), monthlyFetched, sources, daily, monthly }, null, 1));
  console.log("Wrote data/prices.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
