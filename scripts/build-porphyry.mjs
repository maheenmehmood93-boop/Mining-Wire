// Converts the USGS porphyry copper database (a CSV in source/) into the compact
// data/porphyry.json that the Porphyry tab reads. Run it after replacing the CSV:
//
//   node scripts/build-porphyry.mjs
//
// Data: Magnin, B.P., Graham, G.E., Huston, D.L., and Eglington, B.M., 2025,
// A global database of porphyry copper deposits and prospects: U.S. Geological
// Survey data release, https://doi.org/10.5066/P14CCESQ (public domain, CC0).
//
// Only reformatting is done here: text is trimmed, a few spelling variants are
// merged, and blank cells become null. Nothing is estimated, except the contained
// copper figure, which is ore tonnage times copper grade and is labelled as
// calculated on the page.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SRC = new URL("../source/porphyry-usgs-2025.csv", import.meta.url);
const OUT = new URL("../data/porphyry.json", import.meta.url);

/** Small RFC 4180 CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const text = (s) => { const v = clean(s); return v === "" || /^(na|n\/a)$/i.test(v) ? null : v; };
const num = (s) => {
  const v = clean(s).replace(/,/g, "");
  if (v === "" || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sentence = (s) => { const v = text(s); return v && v[0].toUpperCase() + v.slice(1); };
const round = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Broad kind from the USGS/CMMI deposit type, for filtering. */
export function kindOf(type) {
  const t = (type ?? "").toLowerCase();
  if (!t) return "Other";
  if (t.startsWith("possible")) return "Possible porphyry";
  if (t.startsWith("porphyry copper-molybdenum")) return "Porphyry Cu-Mo";
  if (t.startsWith("porphyry copper ± gold")) return "Porphyry Cu-Au";
  if (t.startsWith("porphyry copper")) return "Porphyry Cu";
  if (t.startsWith("porphyry gold")) return "Porphyry Au";
  if (t.startsWith("skarn")) return "Skarn";
  return "Other";
}

/** Age bracket from the assigned numeric age in millions of years. */
export function eraOf(ma) {
  if (ma == null) return "Not dated";
  if (ma < 66) return "Cenozoic (under 66 Ma)";
  if (ma < 252) return "Mesozoic (66 to 252 Ma)";
  if (ma < 541) return "Paleozoic (252 to 541 Ma)";
  return "Precambrian (over 541 Ma)";
}

const TECTONIC = { "not reported": "Not reported", unknown: "Unknown" };

/** CSV text -> { meta, rows }. Rows are arrays in the order of COLS. */
export const COLS = ["name", "country", "lat", "lon", "type", "kind", "group", "subtype", "tectonic", "ageMa", "ageUnc", "ageType", "ageText", "ageMethod", "ageMineral", "ageBasis", "strat", "era", "tonnage", "cu", "mo", "au", "ag", "cuContained", "dbSource", "locRef", "ageRef", "tectRef", "gtRef", "comments"];

export function convert(csvText) {
  const table = parseCsv(csvText);
  const head = table[0].map((h) => clean(h).replace(/^﻿/, ""));
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ["DEPOSIT", "COUNTRY", "LATITUDE", "LONGITUDE"]) if (!(need in ix)) throw new Error(`column ${need} missing from the CSV`);
  const get = (r, k) => (k in ix ? r[ix[k]] : "");
  const rows = [];
  let skipped = 0;
  for (const r of table.slice(1)) {
    const lat = num(get(r, "LATITUDE")), lon = num(get(r, "LONGITUDE"));
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; continue; }
    const type = text(get(r, "CMMI_DEPOSIT_TYPE"));
    const ageMa = num(get(r, "ASSIGNED_AGE_MA"));
    const tonnage = num(get(r, "ORE_TONNAGE_MT")), cu = num(get(r, "CU_PERCENT"));
    const tect = text(get(r, "TECTONIC_SETTING"));
    rows.push([
      text(get(r, "DEPOSIT")) ?? "unnamed",
      text(get(r, "COUNTRY")) ?? "Unknown",
      round(lat, 5), round(lon, 5),
      type, kindOf(type),
      text(get(r, "CMMI_DEPOSIT_GROUP")),
      (() => { const s = sentence(get(r, "REPORTED_DEPOSIT_SUBTYPE")); return s && s.toLowerCase() !== "not reported" ? s : null; })(),
      tect ? TECTONIC[tect.toLowerCase()] ?? sentence(tect) : null,
      ageMa, num(get(r, "NUMERIC_AGE_UNCERTAINTY_MA")),
      (() => { const t = text(get(r, "AGE_TYPE")); return t && !/^not reported$/i.test(t) ? t : null; })(),
      (() => { const t = text(get(r, "PUBLISHED_AGE")); return t && !/^not dated$/i.test(t) ? t : null; })(),
      (() => { const t = text(get(r, "METHOD")); return t && !/^not (reported|dated)$/i.test(t) ? t : null; })(),
      (() => { const t = text(get(r, "DATE_MINERAL")); return t && !/^not reported$/i.test(t) ? t : null; })(),
      (() => { const t = text(get(r, "AGE_BASIS")); return t && !/^not reported$/i.test(t) ? t : null; })(),
      text(get(r, "STRATIGRAPHIC_AGE")),
      eraOf(ageMa),
      tonnage, cu, num(get(r, "MO_PERCENT")), num(get(r, "AU_GT")), num(get(r, "AG_GT")),
      tonnage != null && cu != null ? round((tonnage * cu) / 100, 3) : null, // million tonnes of contained copper
      text(get(r, "ORIGINAL_DATABASE_SOURCE")), text(get(r, "LOCATION_REF")), text(get(r, "AGE_REFERENCES")), text(get(r, "TECTONIC_SETTING_REFERENCE")), text(get(r, "G-T_REF")),
      text(get(r, "COMMENTS")),
    ]);
  }
  if (rows.length < 100) throw new Error(`only ${rows.length} usable rows; is this the right file?`);
  // Largest known deposits first, then by name, so an unsorted view is still useful.
  rows.sort((a, b) => (b[23] ?? -1) - (a[23] ?? -1) || a[0].localeCompare(b[0]));
  const meta = {
    title: "A global database of porphyry copper deposits and prospects",
    authors: "Magnin, B.P., Graham, G.E., Huston, D.L., and Eglington, B.M.",
    year: 2025,
    publisher: "U.S. Geological Survey data release",
    doi: "https://doi.org/10.5066/P14CCESQ",
    licence: "Public domain (CC0 1.0)",
    asOf: "published information as of spring 2024",
    count: rows.length,
    skipped,
  };
  return { meta, cols: COLS, rows };
}

async function main() {
  const buf = await readFile(SRC);
  const csv = new TextDecoder("windows-1252").decode(buf); // the USGS file is not UTF-8
  const out = convert(csv);
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote data/porphyry.json: ${out.rows.length} deposits (${out.meta.skipped} skipped)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
