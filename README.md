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
