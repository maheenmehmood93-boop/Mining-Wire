# Mining Wire

A free, web-based mining news aggregator. A script reads the public RSS feeds of mining publications and Pakistani newspapers every hour, saves headlines, short excerpts and links to `data/news.json`, and a static page (`index.html`) lets readers filter them. Every story links to the original publisher.

No server, database or paid service is needed. It runs on GitHub (free account) with GitHub Pages and GitHub Actions.

## Filters on the page

- **Coverage:** All, International, or National (Pakistan)
- **Period:** Any time, last 24 hours, last 7 days (default), last 30 days
- **Province:** Balochistan or Khyber Pakhtunkhwa. Stories are tagged by place names in the headline and excerpt (Quetta, Chagai, Reko Diq, Peshawar, Swat, Mohmand and so on), so an international story about Reko Diq also shows under Balochistan.
- **Newspapers:** tick or untick individual newspapers, grouped into International and National
- **Commodity:** gold, copper, lithium, coal, marble and others
- **Search** across headlines and excerpts

Each option shows how many stories it would return with the other filters applied.

## Chagai security tab

A second tab, **Chagai security**, lists stories that name a place in Chagai district (Chagai, Dalbandin, Nokkundi, Taftan, Saindak, Reko Diq and nearby, in English or Urdu) **and** use a security word (attack, firing, blast, FC, curfew, kidnapping and so on). It looks at every feed, plus four site searches for "chagai" on Pakistan Observer, The Frontier Post, Daily Times and Daily Pakistan. It opens on the last 30 days because such stories are infrequent.

Selection is by keyword, so it can include a loosely related story and miss one that does not name the place. It is not an official security advisory. The place and security word lists are `CHAGAI_RE` and `SECURITY_RE` in `scripts/fetch-news.mjs`.

## Safety incidents tab

A third tab collects reported mining accidents and safety alerts and groups them by **country** and **type** (collapse or cave-in, explosion or fire, flooding, tailings or dam failure, gas or ventilation, vehicle or equipment, fatality or injury, safety alert or enforcement). It can also be filtered by country or type and grouped by either, or listed newest first.

Selection is by keyword. A story needs an incident word (killed, trapped, collapse, explosion and so on) and, for general newspapers, must also be about mining. The country is the first place named in the headline or excerpt; stories from Pakistani papers with no other country named are filed under Pakistan, anything else unplaced under "Unspecified". The rules are `SAFETY_TYPES`, `INCIDENT_RE` and `COUNTRIES` in `scripts/fetch-news.mjs`. Several "Safety search" feeds in `feeds.json` search MINING.COM, International Mining, Mining.com.au and three Pakistani papers for fatality, accident and coal mine stories. The tab is not a complete or verified incident record.

## Exploration tab

Collects exploration announcements for **copper, gold and lithium**: drill results, discoveries, resource estimates and drilling updates. A story needs one of those metals, a result-type phrase (intersects, drill results, discovery, mineral resource estimate, commences drilling and so on) and project-level wording. Where a headline gives an intercept such as "52 m @ 1.25 g/t Au" it is pulled out as the highlight. Country comes from the first place named, with the Canadian province, US state or Australian state shown where it is mentioned. It can be filtered by metal, country and type, and grouped by country, metal or type.

Sources are company press releases from newswire feeds (marked "Press release"; in `feeds.json` they have `"kind": "press"` and `"filter": "exploration"`, which keeps them off the main mining tab) plus search feeds on the mining publications. The figures are the companies' own and are not verified. The rules are `EX_METALS`, `EX_TYPES` and the grade patterns in `scripts/fetch-news.mjs`. To follow a company directly, add its investor-relations RSS feed to `feeds.json` the same way.

## Prices tab

`scripts/fetch-prices.mjs` runs once a day. Gold, silver, platinum and palladium spot prices and COMEX copper futures come from gold-api.com, and a daily history builds up in `data/prices.json`. Monthly averages for copper, aluminium, nickel, zinc, lead, tin, iron ore and Australian coal come from the World Bank Pink Sheet workbook, which gives the 2-year and 5-year trend charts straight away. The LME official prices are not used (redistribution needs an LME data licence; the Prices tab links to the LME page) and lithium is not shown (no free source).

Clicking "Run workflow" in the Actions tab forces it to run immediately. Locally: `npm run prices`.

## Stock watch tab

`scripts/fetch-stocks.mjs` collects end-of-day closing prices for the international miners in `stocks-list.json` (BHP, Rio Tinto, Vale, Freeport-McMoRan, Southern Copper, Newmont, Barrick, Agnico Eagle, Cameco, Albemarle, MP Materials) from Alpha Vantage, which needs a free key: sign up at alphavantage.co, then in the repository open **Settings, Secrets and variables, Actions, New repository secret**, name it `ALPHAVANTAGE_API_KEY` and paste the key.

Pakistan Stock Exchange companies are listed with links to the exchange's own pages. Their prices are not collected, because the exchange's terms of use do not allow its data to be collected by software and republished; showing them needs a licence from the exchange or an authorised data vendor.

## Companies tab

`data/companies.json` is a hand-kept list: the 40 largest listed miners ranked by market capitalisation (with commodity, country, ticker and website), a short list of companies active in Pakistan, and service providers (consulting and engineering, construction, contract mining and drilling, explosives, machinery, laboratories, software) grouped by category. The ranking refreshes itself about once a week: `scripts/update-companies.mjs` reads companiesmarketcap.com and updates rank, market cap and ticker, while keeping the commodities, websites and notes in the file. A company that newly enters the top 40 is added with no commodity (shown as a dash) until you fill it in, and one that drops out is removed. If the source page cannot be read or its layout changes, the list is left as it was. The Pakistan and service-provider lists are never changed automatically.

## Put it online (about 10 minutes)

1. Create a new **public** repository on GitHub and upload everything in this folder (keep the `.github` folder).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open the **Actions** tab, choose **Update news and deploy**, and click **Run workflow**.
4. When it finishes, your site is at `https://<your-username>.github.io/<repository-name>/`.

After that it refreshes itself every hour.

## Run it on your computer

```bash
npm install
npm run fetch      # downloads the feeds into data/news.json
npm run serve      # then open the address it prints
node test/parse.test.mjs   # checks the feed parser and filters
```

Requires Node.js 20 or newer.

## Choosing sources: feeds.json

Each entry has:

| Field | Meaning |
|---|---|
| `name` | Newspaper name (this is what the Newspapers filter lists) |
| `section` | Optional section, e.g. "Business" |
| `scope` | `International` or `National` |
| `region` | Free-text location label |
| `url` | The RSS feed address |
| `filter` | `mining` keeps only stories about mining and minerals (use for general newspapers); `none` keeps everything (use for mining publications) |
| `province` | Optional. Marks every story from that feed as Balochistan or Khyber Pakhtunkhwa |

After a run, the "Feed status" section at the bottom of the page shows which feeds worked and how many stories were kept out of those seen. A feed that fails does not break the site; earlier stories are kept.

To see all Balochistan stories from a regional feed, not only mining ones, set that feed's `filter` to `none`.

## Notes

- Every story shows a "Source:" line with the link to the original article (for example `dawn.com/news/1963118`). When a feed credits another publisher for the story, such as a wire service, it is shown as "via Reuters". Not every feed does this, so "via" appears only where the feed provides it.
- Only headlines, ~240-character excerpts and links are stored, not full articles.
- The mining keyword list and the province place names are in `scripts/fetch-news.mjs`. Add terms there if you see stories being missed or wrongly included.
- Some publishers change their feed addresses. If a source stops appearing, check its status line and update the `url`.
