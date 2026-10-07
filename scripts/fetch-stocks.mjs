// Collects end-of-day share prices for the companies in stocks-list.json and
// writes data/stocks.json.
//
//  - market "PSX": Pakistan Stock Exchange data portal (dps.psx.com.pk), the
//    public end-of-day history the exchange publishes on its own website.
//  - market "US": Alpha Vantage's free daily price service. It needs a free key
//    in the ALPHAVANTAGE_API_KEY secret (get one at alphavantage.co). Without a
//    key, only the PSX prices are collected.
//
// Prices are closing prices, shown for information only. Run with --force to
// fetch even if the stored prices are recent.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LIST_FILE = new URL("../stocks-list.json", import.meta.url);
const OUT_FILE = new URL("../data/stocks.json", import.meta.url);
const USER_AGENT = "Mozilla/5.0 (compatible; MiningWire/1.0; +https://github.com/maheenmehmood93-boop/Mining-Wire)";
const TIMEOUT_MS = 30000;
const MAX_POINTS = 260;
const PSX_EVERY_HOURS = 3;
const US_EVERY_HOURS = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CURRENCY = { PSX: "PKR", US: "USD" };

/** PSX rows are [epoch seconds, close, volume, open]. Returns [[YYYY-MM-DD, close]] oldest first. */
export function parsePsxEod(json) {
  const rows = json?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error("no price rows in reply");
  const byDate = new Map();
  for (const r of rows) {
    let t = Number(r?.[0]);
    const close = Number(r?.[1]);
    if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) continue;
    if (t > 1e12) t /= 1000; // milliseconds
    // Pakistan time is UTC+5, so a session stamped at midnight local stays on its own day.
    const date = new Date((t + 5 * 3600) * 1000).toISOString().slice(0, 10);
    byDate.set(date, Math.round(close * 100) / 100);
  }
  if (!byDate.size) throw new Error("no usable price rows");
  return [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-MAX_POINTS);
}

/** Alpha Vantage TIME_SERIES_DAILY reply -> [[YYYY-MM-DD, close]] oldest first. */
export function parseAlphaVantage(json) {
  const series = json?.["Time Series (Daily)"];
  if (!series) {
    const why = json?.["Error Message"] ?? json?.Note ?? json?.Information ?? "unexpected reply";
    throw new Error(String(why).slice(0, 160));
  }
  const pts = Object.entries(series)
    .map(([d, v]) => [d, Math.round(Number(v?.["4. close"]) * 100) / 100])
    .filter(([, c]) => Number.isFinite(c) && c > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!pts.length) throw new Error("no usable price rows");
  return pts.slice(-MAX_POINTS);
}

/** Union of earlier and new points by date (new wins), oldest first. */
export function mergePoints(old = [], fresh = [], max = MAX_POINTS) {
  const m = new Map(old.map((p) => [p[0], p[1]]));
  for (const [d, c] of fresh) m.set(d, c);
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-max);
}

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", Referer: "https://dps.psx.com.pk/" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return {};
  }
}

const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso)) / 3600000 : Infinity);

async function main() {
  const force = process.argv.includes("--force");
  const list = JSON.parse(await readFile(LIST_FILE, "utf8"));
  const prev = await loadPrevious();
  const stocks = { ...(prev.stocks ?? {}) };
  const fetched = { ...(prev.fetched ?? {}) };
  const sources = [];

  // Companies removed from stocks-list.json disappear from the page.
  for (const id of Object.keys(stocks)) if (!list.some((s) => s.id === id)) delete stocks[id];

  const record = (s, points) => {
    stocks[s.id] = {
      name: s.name, full: s.full ?? s.name, symbol: s.symbol, market: s.market, currency: s.unit ?? CURRENCY[s.market] ?? "",
      points: mergePoints(stocks[s.id]?.points, points),
    };
  };

  // --- Pakistan Stock Exchange --------------------------------------------
  const psx = list.filter((s) => s.market === "PSX");
  if (psx.length) {
    if (force || hoursSince(fetched.psx) >= PSX_EVERY_HOURS) {
      let ok = 0;
      let lastError = "";
      for (const s of psx) {
        try {
          const pts = parsePsxEod(await getJson(`https://dps.psx.com.pk/timeseries/eod/${encodeURIComponent(s.symbol)}`));
          record(s, pts);
          ok++;
          console.log(`ok    ${s.name}: ${pts.at(-1)[1]} PKR (${pts.at(-1)[0]})`);
        } catch (e) {
          lastError = String(e?.cause?.code ?? e?.message ?? e);
          console.warn(`FAIL  ${s.name}: ${lastError}`);
        }
        await sleep(1000);
      }
      if (ok) fetched.psx = new Date().toISOString();
      sources.push({ name: "Pakistan Stock Exchange data portal", ok: ok > 0, detail: `${ok} of ${psx.length} companies`, error: ok ? "" : lastError });
    } else {
      sources.push(...(prev.sources ?? []).filter((x) => /Pakistan Stock/.test(x.name)));
    }
  }

  // --- International (Alpha Vantage) ---------------------------------------
  const us = list.filter((s) => s.market === "US");
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (us.length) {
    if (!key) {
      sources.push({ name: "Alpha Vantage (international)", ok: false, detail: "", error: "no API key set (add the ALPHAVANTAGE_API_KEY secret)" });
      console.warn("SKIP  international prices: ALPHAVANTAGE_API_KEY is not set");
    } else if (force || hoursSince(fetched.us) >= US_EVERY_HOURS) {
      let ok = 0;
      let lastError = "";
      for (const s of us) {
        try {
          const j = await getJson(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(s.symbol)}&outputsize=compact&apikey=${encodeURIComponent(key)}`);
          const pts = parseAlphaVantage(j);
          record(s, pts);
          ok++;
          console.log(`ok    ${s.name}: ${pts.at(-1)[1]} USD (${pts.at(-1)[0]})`);
        } catch (e) {
          lastError = String(e?.cause?.code ?? e?.message ?? e);
          console.warn(`FAIL  ${s.name}: ${lastError}`);
          if (/rate|limit|call frequency|premium/i.test(lastError)) break; // no point continuing
        }
        await sleep(1500);
      }
      if (ok) fetched.us = new Date().toISOString();
      sources.push({ name: "Alpha Vantage (international)", ok: ok > 0, detail: `${ok} of ${us.length} companies`, error: ok ? "" : lastError });
    } else {
      sources.push(...(prev.sources ?? []).filter((x) => /Alpha Vantage/.test(x.name)));
    }
  }

  if (!Object.keys(stocks).length) {
    console.log("No share prices collected; nothing written.");
    return;
  }
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), fetched, sources, stocks }, null, 1));
  console.log("Wrote data/stocks.json");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
