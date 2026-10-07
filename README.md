# Extract Anchor Entries

Scans every entry of a Contentstack content type (by default **Teaser**) in every locale and lists the entry/locale pairs whose **Raw HTML Input** field contains anchor (`<a>`) tags.

It uses the Content Management API (CMA) on the Azure EU data center and throttles itself to a configurable number of requests per second.

## Requirements

- Node.js 20.12 or newer (uses built-in `fetch` and `process.loadEnvFile`; no npm dependencies)
- A stack API key and a management token with read access to the content type, global fields and locales

## Configuration

All settings live in `.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `CS_API_KEY` | — | Stack API key (required) |
| `CS_MANAGEMENT_TOKEN` | — | Management token (required) |
| `CS_BRANCH` | `main` | Branch to read from |
| `CS_CMA_HOST` | `azure-eu-api.contentstack.com` | CMA host for the data center |
| `CS_RPS` | `8` | Max requests per second sent to the CMA |
| `CONTENT_TYPE_UID` | `teaser` | Content type to scan |
| `HTML_FIELD` | `Raw HTML Input` | Display name or UID of the HTML field |

`.env` is git-ignored. Never commit real tokens.

### Rate limit

The CMA allows 10 requests per second per **organization**, and every integration or user hitting the same organization shares that limit. The default of `8` leaves some headroom. Lower it if other jobs run at the same time.

## Usage

```bash
npm start
```

or

```bash
node extract-anchor-entries.mjs
```

The script logs progress per locale and writes two files to `output/`:

- `anchor-entries-<timestamp>.csv`: one row per matching field, with columns `entry_uid, locale, title, version, field_path, anchor_count`
- `anchor-entries-<timestamp>.json`: the same data, plus the matched `<a …>` tags for each field

## How it works

1. **Load the schema.** The script fetches the content type schema and finds the HTML field by display name or UID. The field can sit at the top level or inside groups, global fields or modular blocks. Global field schemas are fetched when they aren't included in the content type.
2. **Load the locales.** It fetches all stack locales from `/v3/locales`.
3. **Page through entries.** For each locale, it reads the entries 100 at a time (the CMA maximum).
4. **Skip fallback copies.** When an entry isn't localized in the requested locale, the CMA returns the fallback-locale version. Those are skipped (`entry.locale !== locale`), so each result reflects content that actually exists in that locale.
5. **Match anchors.** Each HTML value is checked with `/<a(?:\s[^>]*)?>/i`. This matches `<a>` and `<a href="…">` in any case, but not tags like `<abbr>`.

### Rate limiting and retries

- Request starts are spaced at least `1000 / CS_RPS` ms apart, so the client never exceeds the configured rate.
- On HTTP `429` or `5xx` responses and network errors, the script retries up to 6 times. It honours `Retry-After` when present and otherwise uses exponential backoff, capped at 30 s.
- During a backoff, the whole client pauses, not just the failed request.
