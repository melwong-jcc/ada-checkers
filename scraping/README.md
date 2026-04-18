# Scraping a page

Install:
1. nvm install 20
2. nvm use 20
3. npm install
4. npm run build

Usage:

```shell
npm test http://url/to/page
npm test http://url/to/page --level=A
```

If no URL is provided, the [fixture](fixtures/page.html) page will be tested instead.

The audit report is saved in the `outcomes` directory as both EARL JSON and a human-readable CSV.

- Fixture runs write `outcomes/page.html.json` and `outcomes/page.html.csv`
- Remote page runs write `outcomes/<host>/<path>--issues.json` and `outcomes/<host>/<path>--issues.csv`

The CSV includes these columns:

- `page_url`
- `rule_id`
- `rule_url`
- `outcome`
- `message`
- `pointer`
- `element`

The `element` column summarizes the impacted DOM node using its tag, id/classes, and any available text, ARIA label, or href.