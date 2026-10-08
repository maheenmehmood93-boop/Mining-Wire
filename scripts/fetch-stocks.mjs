// Collects end-of-day share prices for the international miners in
// stocks-list.json and writes data/stocks.json.
//
// Prices come from Alpha Vantage's free daily price service. It needs a free key
// in the ALPHAVANTAGE_API_KEY secret (get one at alphavantage.co).
//
// Pakistan Stock Exchange prices are deliberately not collected here: the
// exchange's terms of use do not allow its data to be collected by software and
// republished. The Stock watch tab links to the exchange's own pages instead.
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
const US_EVERY_HOURS = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
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

  // Companies removed from stocks-list.json (and any earlier non-US entries) disappear from the page.
  for (const id of Object.keys(stocks)) if (!list.some((s) => s.id === id)) delete stocks[id];

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
          stocks[s.id] = { name: s.name, full: s.full ?? s.name, symbol: s.symbol, market: s.market, currency: "USD", points: mergePoints(stocks[s.id]?.points, pts) };
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

  // Written even when nothing was collected, so the page can show why.
  if (!Object.keys(stocks).length) console.warn("No share prices collected; writing the file so the page shows the reason.");
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
