// Watches government pages for new notices, tenders and auction announcements
// and records what it finds in data/notices.json.
//
// How it works: each watched page is downloaded, every link on it is read, and
// links that look like notices (documents, or text with words such as tender,
// auction, notification, licence, policy) are kept. A link not seen on an
// earlier run is recorded with the date it first appeared. Only the title, link
// and a date shown on the page are stored.
//
// Run with --force to check even if the last check was recent.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SOURCES_FILE = new URL("../notice-sources.json", import.meta.url);
const OUT_FILE = new URL("../data/notices.json", import.meta.url);
const USER_AGENT = "Mozilla/5.0 (compatible; MiningWire/1.0; +https://github.com/maheenmehmood93-boop/Mining-Wire)";
const TIMEOUT_MS = 25000;
const MIN_HOURS_BETWEEN_CHECKS = 5;
const KEEP_DAYS = 120;
const MAX_ITEMS = 600;

const DOC_RE = /\.(?:pdf|docx?|xlsx?|zip)(?:[?#].*)?$/i;
const NOTICE_RE =
  /\b(?:tenders?|bids?|bidding|auctions?|notices?|notifications?|advertisements?|advert|licen[cs]es?|leases?|policy|policies|rules|regulations?|act|ordinance|expression of interest|eoi|pre-?qualification|request for proposals?|rfp|mineral titles?|exploration|reconnaissance|concessions?|corrigendum|extension|cancell?ed|results?|minutes)\b/i;
const MINERAL_RE =
  /\b(?:minerals?|mining|mines?|quarr\w+|rock salt|salt|coal|gypsum|marble|granite|copper|gold|lithium|chromite|limestone|reko\s?-?(?:diq|dik)|saindak|geolog\w+|prospecting)\b/i;
const GENERIC_LINK_RE =
  /^(?:home|tenders?|tenders? (?:&|and) notifications?|notifications?|notices?|news(?: (?:&|and) updates?)?|downloads?|contact(?: us)?|about(?: us)?|read more|more|view|view all|click here|pdf|skip to content|search|login|sitemap|faqs?|gallery|careers?|jobs?|privacy policy|terms(?: (?:&|and) conditions)?)$/i;
const ACTION_LINK_RE = /^(?:download|view|pdf|click here|read more|more|details?|open|link|attachment)$/i;
const SOCIAL_RE = /(?:facebook|twitter|x|youtube|instagram|linkedin|whatsapp|t)\.(?:com|me)$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const decode = (s) =>
  s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#8217;|&#039;|&#39;|&apos;/g, "'")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const stripTags = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();

const keyOf = (url) => url.replace(/#.*$/, "").replace(/\/+$/, "");
const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");

/** First date written in the text, as YYYY-MM-DD, or null. Handles "21 Oct 2026" and "21-10-2026". */
export function findDate(text) {
  let m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?[\s-]+(\d{4})\b/i.exec(text);
  let d, mo, y;
  if (m) [d, mo, y] = [Number(m[1]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[3])];
  else if ((m = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/.exec(text))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function classifyNotice(title) {
  if (/\bauctions?\b/i.test(title)) return "Auction";
  if (/\b(?:tenders?|bids?|bidding|eoi|expression of interest|pre-?qualification|request for proposals?|rfp|corrigendum)\b/i.test(title)) return "Tender";
  if (/\b(?:policy|policies|rules|regulations?|act|ordinance|framework)\b/i.test(title)) return "Policy / rules";
  if (/\b(?:licen[cs]es?|leases?|mineral titles?|exploration|reconnaissance|concessions?|grant of)\b/i.test(title)) return "Licence";
  if (/\b(?:notifications?|notices?|advertisements?|advert)\b/i.test(title)) return "Notification";
  return "Other";
}

/**
 * Reads the links of a page that look like notices.
 * `watched` = page addresses that are being watched (their own links are skipped).
 */
export function extractNotices(html, pageUrl, watched = []) {
  const watchedKeys = new Set(watched.map(keyOf));
  const host = hostOf(pageUrl);
  const found = new Map();
  let total = 0;

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = decode((hrefMatch[1] ?? hrefMatch[2]).trim());
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;

    let url;
    try {
      url = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) continue;
    total++;
    if (hostOf(url) !== host || SOCIAL_RE.test(hostOf(url))) continue;
    if (watchedKeys.has(keyOf(url)) || keyOf(url) === keyOf(pageUrl)) continue;

    // Table rows hold the details of a tender, so use the row as context.
    const start = m.index;
    const rowStart = html.lastIndexOf("<tr", start);
    const rowEnd = html.indexOf("</tr>", start);
    const inRow = rowStart >= 0 && rowEnd > start && start - rowStart < 4000;
    const rowText = inRow ? stripTags(html.slice(rowStart, rowEnd)) : "";

    const text = stripTags(m[2]) || decode((/title\s*=\s*"([^"]*)"/i.exec(attrs) ?? [])[1] ?? "").trim();
    let title = text;
    if (!title || ACTION_LINK_RE.test(title)) title = rowText.replace(/\b(?:download|view|pdf)\b/gi, " ").replace(/\s+/g, " ").trim();
    title = title.slice(0, 220);
    if (title.length < 6 || GENERIC_LINK_RE.test(title)) continue;

    const isDoc = DOC_RE.test(new URL(url).pathname);
    if (!(isDoc || NOTICE_RE.test(title) || (rowText && NOTICE_RE.test(rowText)))) continue;

    const key = keyOf(url);
    if (!found.has(key)) {
      let type = classifyNotice(title + " " + (rowText.length < 400 ? rowText : ""));
      if (type === "Other" && /tender/i.test(pageUrl)) type = "Tender"; // listed on a tenders page
      found.set(key, { url, title, type, date: findDate(rowText || title) });
    }
  }
  return { links: total, notices: [...found.values()] };
}

/** Combines earlier results with a new check. */
export function mergeNotices(previous, fresh, sourceIds, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const byUrl = new Map();
  const hadItems = new Set(previous.map((p) => p.sourceId));

  for (const p of previous) if (sourceIds.has(p.sourceId)) byUrl.set(keyOf(p.url), p);
  for (const f of fresh) {
    const key = keyOf(f.url);
    const old = byUrl.get(key);
    byUrl.set(key, old ? { ...old, title: f.title, type: f.type, date: f.date ?? old.date, lastSeen: nowIso } : { ...f, firstSeen: nowIso, lastSeen: nowIso, initial: !hadItems.has(f.sourceId) });
  }

  const cutoff = now - KEEP_DAYS * 86400000;
  return [...byUrl.values()]
    .filter((i) => new Date(i.lastSeen).getTime() >= cutoff)
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : (b.date ?? "").localeCompare(a.date ?? "")))
    .slice(0, MAX_ITEMS);
}

// "fetch failed" on its own says nothing; add the underlying cause (timeout,
// connection refused, certificate problem ...) so the status line is useful.
const describeError = (e) => {
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message}: ${cause}` : String(e?.message ?? e);
};

async function fetchOnce(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchPage(url) {
  try {
    return await fetchOnce(url);
  } catch (e) {
    if (/^HTTP 4/.test(e.message)) throw new Error(describeError(e)); // refused, no point retrying
    await new Promise((r) => setTimeout(r, 3000));
    try {
      return await fetchOnce(url);
    } catch (e2) {
      throw new Error(describeError(e2));
    }
  }
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const sources = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const prev = await loadPrevious();

  if (!force && prev.checked && (Date.now() - new Date(prev.checked)) / 3600000 < MIN_HOURS_BETWEEN_CHECKS) {
    console.log(`Last check was at ${prev.checked}; skipping (use --force to check now).`);
    return;
  }

  const watched = sources.flatMap((s) => s.pages);
  const fresh = [];
  const report = [];

  for (const s of sources) {
    const pages = [];
    for (const url of s.pages) {
      try {
        const html = await fetchPage(url);
        const { links, notices } = extractNotices(html, url, watched);
        const kept = s.filter === "mining" ? notices.filter((n) => MINERAL_RE.test(n.title)) : notices;
        fresh.push(...kept.map((n) => ({ ...n, sourceId: s.id, authority: s.authority, province: s.province || "", page: url })));
        pages.push({
          url, ok: true, links, kept: kept.length,
          note: links === 0 ? "no links found; the page may need JavaScript to load its content" : "",
        });
        console.log(`ok    ${s.authority} ${url}: ${links} links, ${kept.length} kept`);
      } catch (e) {
        pages.push({ url, ok: false, error: String(e.message ?? e) });
        console.warn(`FAIL  ${s.authority} ${url}: ${e.message ?? e}`);
      }
    }
    report.push({ id: s.id, authority: s.authority, pages });
  }

  const items = mergeNotices(prev.items ?? [], fresh, new Set(sources.map((s) => s.id)));

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ checked: new Date().toISOString(), sources: report, items }, null, 1));
  console.log(`Wrote ${items.length} notices.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
