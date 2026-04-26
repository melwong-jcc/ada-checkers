# Scraping a page

Install:
1. Install the Node.js version mentioned in parent [README.md](../README.md)
1. npm install
1. npm run build (repeated if adjusting TypeScript source)

Usage:

```shell
npm test http://url/to/page
```

If no URL is provided, the [fixture](fixtures/page.html) page will be tested instead.

The audit report is saved in the `outcomes` directory as both EARL JSON and a human-readable CSV.

- Fixture runs write `outcomes/page.html.json` and `outcomes/page.html.csv`
- Remote page runs write `outcomes/<host>/<path>--issues.json` and `outcomes/<host>/<path>--issues.csv`
- Uses both stable and experimental rules to nearly match the auditing from the web platform version

The CSV includes these columns:

- `page_url`
- `rule_id`
- `rule_url`
- `wcag_criteria`
- `conformance`
- `outcome`
- `message` describes the incident
- `element` summarizes the impacted DOM node using its tag, id/classes, and any available text, ARIA label, or href

## Optional Siteimprove integration
Integration with Siteimprove's API is still under development. If Accessibility Code Checker integration is currently included in our subscription:

```shell
cp .env.example .env
```

Then set the values in `.env`:

```dotenv
SITEIMPROVE_USERNAME=you@example.com
SITEIMPROVE_API_KEY=your-api-key
```

The scraper loads `.env` automatically. Regular shell environment variables still work and override file-based values.

Optional overrides:

- `SITEIMPROVE_API_BASE_URL` defaults to `https://api.siteimprove.com/v2`

When Siteimprove credentials are present, the scraper uploads the page HTML to `POST /content/check`, then stores Siteimprove's generated results alongside the local ALFA report.

- Fixture runs also write `outcomes/page.html.siteimprove-summary.json` and `outcomes/page.html.siteimprove-issues.json`
- Remote page runs also write `outcomes/<host>/<path>--issues.siteimprove-summary.json` and `outcomes/<host>/<path>--issues.siteimprove.json`

This integration triggers Siteimprove's own analysis of the uploaded HTML. It does not import the scraper's findings as custom Siteimprove issues.
