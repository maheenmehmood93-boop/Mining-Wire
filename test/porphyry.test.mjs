import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv, convert, kindOf, eraOf, COLS } from "../scripts/build-porphyry.mjs";

// CSV reader: quotes, doubled quotes, commas and newlines inside quotes, CRLF, blank lines
assert.deepEqual(parseCsv('a,b,c\r\n1,"x, y",3\n\n"he said ""hi""","line1\nline2",\n'), [["a", "b", "c"], ["1", "x, y", "3"], ['he said "hi"', "line1\nline2", ""]]);

// classification helpers
assert.equal(kindOf("Porphyry copper"), "Porphyry Cu");
assert.equal(kindOf("Porphyry copper-molybdenum"), "Porphyry Cu-Mo");
assert.equal(kindOf("Porphyry copper-molybdenum - Skarn copper"), "Porphyry Cu-Mo");
assert.equal(kindOf("Porphyry copper ± gold"), "Porphyry Cu-Au");
assert.equal(kindOf("Possible porphyry copper"), "Possible porphyry");
assert.equal(kindOf("Skarn copper"), "Skarn");
assert.equal(kindOf(null), "Other");
assert.equal(eraOf(null), "Not dated");
assert.equal(eraOf(11.8), "Cenozoic (under 66 Ma)");
assert.equal(eraOf(90), "Mesozoic (66 to 252 Ma)");
assert.equal(eraOf(300), "Paleozoic (252 to 541 Ma)");
assert.equal(eraOf(2700), "Precambrian (over 541 Ma)");

// conversion on a small sample
const head = "DEPOSIT,ORIGINAL_DATABASE_SOURCE,COUNTRY,COUNTRY_ABR,LATITUDE,LONGITUDE,LOCATION_REF,CMMI_DEPOSIT_ENVIRONMENT,CMMI_DEPOSIT_GROUP,CMMI_DEPOSIT_TYPE,REPORTED_DEPOSIT_SUBTYPE,PUBLISHED_AGE,AGE_TYPE,AGE_BASIS,METHOD,DATE_MINERAL,NUMERIC_AGE_MINER_MA,NUMERIC_AGE_UNCERTAINTY_MA,STRATIGRAPHIC_AGE,STRAT_AGE_MAX_MA,STRAT_AGE_MIN_MA,STRAT_AGE_MEDIAN_MA,ASSIGNED_AGE_MA,AGE_REFERENCES,TECTONIC_SETTING,TECTONIC_SETTING_REFERENCE,ORE_TONNAGE_MT,CU_PERCENT,MO_PERCENT,AU_GT,AG_GT,G-T_REF,COMMENTS";
const mk = (o) => COLS && head.split(",").map((h) => o[h] ?? "").join(",");
const lines = [head];
for (let i = 0; i < 100; i++) lines.push(mk({ DEPOSIT: "Filler " + i, COUNTRY: "Chile", LATITUDE: "-30", LONGITUDE: "-70", CMMI_DEPOSIT_TYPE: "Porphyry copper" }));
lines.push(mk({ DEPOSIT: "Big One", COUNTRY: "Chile", LATITUDE: "-24.27", LONGITUDE: "-69.07", CMMI_DEPOSIT_TYPE: "Porphyry copper-molybdenum", REPORTED_DEPOSIT_SUBTYPE: "calc-alkaline", AGE_TYPE: "Direct", METHOD: "Re-Os ", ASSIGNED_AGE_MA: "36.5", TECTONIC_SETTING: "continental arc", ORE_TONNAGE_MT: " 1000 ", CU_PERCENT: "0.5", AU_GT: "0.1", COMMENTS: "Grade-tonnage are code compliant resources." }));
lines.push(mk({ DEPOSIT: "Bad Coords", COUNTRY: "X", LATITUDE: "", LONGITUDE: "10" }));
lines.push(mk({ DEPOSIT: "Out Of Range", COUNTRY: "X", LATITUDE: "95", LONGITUDE: "10" }));
lines.push(mk({ DEPOSIT: "Accent ±", COUNTRY: "Peru", LATITUDE: "-10", LONGITUDE: "-75", TECTONIC_SETTING: "not reported", AGE_TYPE: "Not reported", PUBLISHED_AGE: "Not dated" }));
const out = convert(lines.join("\n"));
const ix = Object.fromEntries(out.cols.map((c, i) => [c, i]));
assert.equal(out.rows.length, 102, "bad and out-of-range coordinates are skipped");
assert.equal(out.meta.skipped, 2);
assert.equal(out.rows[0][ix.name], "Big One", "largest contained copper first");
const big = out.rows[0];
assert.equal(big[ix.cuContained], 5, "1000 Mt x 0.5 % = 5 Mt");
assert.equal(big[ix.tonnage], 1000);
assert.equal(big[ix.subtype], "Calc-alkaline");
assert.equal(big[ix.kind], "Porphyry Cu-Mo");
assert.equal(big[ix.tectonic], "Continental arc");
assert.equal(big[ix.ageMethod], "Re-Os");
assert.equal(big[ix.era], "Cenozoic (under 66 Ma)");
assert.equal(big[ix.au], 0.1);
const peru = out.rows.find((r) => r[ix.country] === "Peru");
assert.equal(peru[ix.tectonic], "Not reported");
assert.equal(peru[ix.ageType], null);
assert.equal(peru[ix.ageText], null);
assert.equal(peru[ix.cuContained], null);
assert.ok(out.rows.every((r) => r.length === out.cols.length));
assert.throws(() => convert("DEPOSIT,COUNTRY\nA,B"), /LATITUDE missing/);
assert.throws(() => convert([head, mk({ DEPOSIT: "A", COUNTRY: "B", LATITUDE: "1", LONGITUDE: "1" })].join("\n")), /only 1 usable rows/);

// the real USGS file and the file the site reads agree
const real = convert(new TextDecoder("windows-1252").decode(readFileSync(new URL("../source/porphyry-usgs-2025.csv", import.meta.url))));
assert.equal(real.rows.length, 2394);
assert.equal(real.meta.skipped, 0);
assert.equal(real.rows.filter((r) => r[ix.cuContained] != null).length, 852);
assert.equal(new Set(real.rows.map((r) => r[ix.country])).size, 68);
const pk = real.rows.filter((r) => r[ix.country] === "Pakistan");
assert.equal(pk.length, 22);
const reko = pk.find((r) => r[ix.name] === "Reko Diq");
assert.equal(reko[ix.tonnage], 4906);
assert.equal(reko[ix.cu], 0.49);
assert.ok(Math.abs(reko[ix.cuContained] - 24.039) < 0.01);
const shipped = JSON.parse(readFileSync(new URL("../data/porphyry.json", import.meta.url), "utf8"));
assert.deepEqual(shipped.rows, real.rows, "data/porphyry.json is up to date with the CSV (run: node scripts/build-porphyry.mjs)");

console.log("porphyry tests passed");
