name: Update news and deploy

on:
  schedule:
    - cron: "17 * * * *" # hourly
  workflow_dispatch: {}
  push:
    branches: [main]

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Fetch feeds
        run: node scripts/fetch-news.mjs

      # Prices are collected once a day; a failure here does not stop the site
      # updating. Clicking "Run workflow" by hand forces a fetch straight away.
      - name: Fetch commodity prices
        continue-on-error: true
        run: node scripts/fetch-prices.mjs ${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}

      # Share prices: Pakistan Stock Exchange needs nothing; the international
      # prices need a free Alpha Vantage key saved as the ALPHAVANTAGE_API_KEY secret.
      - name: Fetch share prices
        continue-on-error: true
        env:
          ALPHAVANTAGE_API_KEY: ${{ secrets.ALPHAVANTAGE_API_KEY }}
        run: node scripts/fetch-stocks.mjs ${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}

      # Company ranking: refreshed about weekly from companiesmarketcap.com. If the
      # source page cannot be read, the existing list is left as it is.
      - name: Refresh company ranking
        continue-on-error: true
        run: node scripts/update-companies.mjs ${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}

      - name: Commit refreshed data
        run: |
          git config user.name "news-bot"
          git config user.email "news-bot@users.noreply.github.com"
          git add data/
          git diff --staged --quiet || git commit -m "Update news data"
          git push || true

      - name: Assemble site
        run: |
          mkdir _site
          cp index.html _site/
          cp -r data _site/data

      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
