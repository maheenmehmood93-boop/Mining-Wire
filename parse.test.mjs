import assert from "node:assert/strict";
import { parseFeedXml, mergeItems, isMiningStory, findProvinces } from "../scripts/fetch-news.mjs";

const rss = (items) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>${items}</channel></rss>`;
const item = (title, desc = "", link = "https://example.com/" + encodeURIComponent(title), date = "Mon, 05 Oct 2026 08:00:00 GMT") =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description><![CDATA[${desc}]]></description></item>`;

// --- parsing: RSS and Atom -------------------------------------------------
const intl = { name: "Test Mining", scope: "International", region: "Global", filter: "none" };
const a = parseFeedXml(
  rss(
    `<item><title>Copper price climbs as Chile output slips</title><link>https://example.com/a?utm=1</link>
     <pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>
     <description><![CDATA[<p>Copper rose &amp; Chile output fell.</p> The post Copper price appeared first on Example.]]></description>
     <media:content url="https://example.com/a.jpg" medium="image"/></item>
     <item><title>No link item</title></item>`
  ),
  intl
);
assert.equal(a.total, 1, "items without links are dropped");
assert.equal(a.items[0].summary, "Copper rose & Chile output fell.");
assert.deepEqual(a.items[0].tags, ["Copper"]);
assert.equal(a.items[0].image, "https://example.com/a.jpg");
assert.equal(a.items[0].scope, "International");

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Lithium project approved</title><link rel="alternate" href="https://example.com/b"/>
<updated>2026-10-04T10:00:00Z</updated><summary>Gold and lithium update.</summary></entry></feed>`;
const b = parseFeedXml(atom, intl);
assert.equal(b.items[0].link, "https://example.com/b");
assert.deepEqual(b.items[0].tags.sort(), ["Gold", "Lithium"]);
assert.throws(() => parseFeedXml("<html></html>", intl), /no items/);

// --- original publisher credited by the feed --------------------------------
const credited = parseFeedXml(
  rss(
    `<item><title>Wire story</title><link>https://example.com/w1</link><source url="https://www.reuters.com/">Reuters</source></item>
     <item><title>Own story</title><link>https://example.com/w2</link><source url="https://example.com/">Test Mining</source></item>
     <item><title>Bad url</title><link>https://example.com/w3</link><source url="javascript:alert(1)">Reuters</source></item>
     <item><title>Plain</title><link>https://example.com/w4</link></item>`
  ),
  intl
);
assert.deepEqual(credited.items.map((i) => [i.via, i.viaUrl]), [
  ["Reuters", "https://www.reuters.com/"],
  ["", ""], // feed crediting itself is not shown
  ["Reuters", ""], // unsafe url dropped, name kept
  ["", ""],
]);
const atomVia = parseFeedXml(
  `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>X</title><link href="https://example.com/x"/><source><title>Bloomberg</title><link href="https://www.bloomberg.com/"/></source></entry></feed>`,
  intl
);
assert.deepEqual([atomVia.items[0].via, atomVia.items[0].viaUrl], ["Bloomberg", "https://www.bloomberg.com/"]);

// --- relevance filter for general newspapers -------------------------------
const paper = { name: "Test Paper", scope: "National", region: "Pakistan", filter: "mining" };
const kept = parseFeedXml(
  rss(
    [
      item("Cabinet approves new mineral policy for Balochistan"),
      item("PTI talks deadlocked over policy"),
      item("Bitcoin mining to get cheap power, minister says"),
      item("Gold rates fall by Rs2,000 per tola"),
      item("Thar coal output rises to record level"),
      item("Reko Diq financing update", "Barrick said work continues."),
      item("Pakistan hosts mineral water exhibition"),
      item("Gold mining licence granted in Chitral"),
      item("چترال میں معدنیات کی تلاش کا آغاز"),
    ].join("")
  ),
  paper
);
assert.equal(kept.total, 9);
assert.deepEqual(
  kept.items.map((i) => i.title),
  [
    "Cabinet approves new mineral policy for Balochistan",
    "Thar coal output rises to record level",
    "Reko Diq financing update",
    "Gold mining licence granted in Chitral",
    "چترال میں معدنیات کی تلاش کا آغاز",
  ]
);
// "none" filter keeps everything
assert.equal(parseFeedXml(rss(item("PTI talks deadlocked")), intl).items.length, 1);

// --- province tagging -------------------------------------------------------
assert.deepEqual(findProvinces("Reko Diq copper project in Chagai"), ["Balochistan"]);
assert.deepEqual(findProvinces("Marble quarries in Mohmand district"), ["Khyber Pakhtunkhwa"]);
assert.deepEqual(findProvinces("K-P government announces mining rules"), ["Khyber Pakhtunkhwa"]);
assert.deepEqual(findProvinces("KP Oli visits Beijing"), [], "Nepal's KP Oli is not Khyber Pakhtunkhwa");
assert.deepEqual(findProvinces("Quetta and Peshawar sign MoU").sort(), ["Balochistan", "Khyber Pakhtunkhwa"]);
assert.deepEqual(findProvinces("Possibility of new rules"), [], "no substring matches");
assert.deepEqual(findProvinces("Coal in Duki", "Khyber Pakhtunkhwa").sort(), ["Balochistan", "Khyber Pakhtunkhwa"], "feed hint is kept");
assert.deepEqual(findProvinces("چترال میں معدنیات"), ["Khyber Pakhtunkhwa"]);
const hinted = parseFeedXml(rss(item("New mining policy announced")), { ...paper, province: "Balochistan" });
assert.deepEqual(hinted.items[0].provinces, ["Balochistan"]);

assert.ok(isMiningStory("Saindak copper-gold project extended"));
assert.ok(!isMiningStory("Government raises petrol price"));

// --- merging ----------------------------------------------------------------
const now = Date.parse("2026-10-06T05:00:00Z");
const mk = (over) => ({ title: "t", link: "https://e.com/x", date: "2026-10-05T00:00:00.000Z", source: "Test Paper", provinces: [], tags: [], ...over });
const merged = mergeItems(
  [
    mk({ link: "https://e.com/old", date: "2026-08-01T00:00:00.000Z" }), // too old
    mk({ link: "https://e.com/gone", source: "Removed Paper" }), // source no longer configured
    mk({ link: "https://e.com/keep" }), // kept from earlier run
  ],
  [
    mk({ link: "https://e.com/x/?utm=1", provinces: ["Balochistan"] }),
    mk({ link: "https://e.com/x", provinces: ["Khyber Pakhtunkhwa"] }), // same story from a second section
    mk({ link: "https://e.com/future", date: "2026-10-20T00:00:00.000Z" }),
    mk({ link: "https://e.com/nodate", date: null }),
  ],
  new Set(["Test Paper"]),
  now
);
assert.deepEqual(merged.map((i) => i.link).sort(), ["https://e.com/keep", "https://e.com/nodate", "https://e.com/future", "https://e.com/x"].sort());
assert.deepEqual(merged.find((i) => i.link === "https://e.com/x").provinces.sort(), ["Balochistan", "Khyber Pakhtunkhwa"]);
assert.equal(merged.find((i) => i.link === "https://e.com/future").date, new Date(now).toISOString(), "future dates clamp to now");
assert.equal(merged.find((i) => i.link === "https://e.com/keep").scope, "International", "old items get defaults");

console.log("all tests passed");
