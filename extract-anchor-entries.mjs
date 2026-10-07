#!/usr/bin/env node
// Lists every entry/locale of a content type whose HTML field contains <a> tags.
// Uses the Contentstack Content Management API with a client-side rate limiter.

import { mkdirSync, writeFileSync } from 'node:fs';

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch {
  // fall back to variables already present in the environment
}

const {
  CS_API_KEY,
  CS_MANAGEMENT_TOKEN,
  CS_BRANCH,
  CS_CMA_HOST = 'azure-eu-api.contentstack.com',
  CS_RPS = '8',
  CONTENT_TYPE_UID = 'teaser',
  HTML_FIELD = 'Raw HTML Input',
} = process.env;

if (!CS_API_KEY || !CS_MANAGEMENT_TOKEN) {
  console.error('CS_API_KEY and CS_MANAGEMENT_TOKEN must be set in .env');
  process.exit(1);
}

const RPS = Number(CS_RPS);
if (!(RPS > 0)) {
  console.error(`CS_RPS must be a positive number, got "${CS_RPS}"`);
  process.exit(1);
}

const BASE_URL = `https://${CS_CMA_HOST}/v3`;
const PAGE_SIZE = 100; // CMA maximum
const MAX_RETRIES = 6;
const ANCHOR_RE = /<a(?:\s[^>]*)?>/gi;

// ---------------------------------------------------------------------------
// Rate limiting: requests are started no closer than 1000/RPS ms apart.
// ---------------------------------------------------------------------------
const minInterval = 1000 / RPS;
let nextSlot = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + minInterval;
  if (slot > now) await sleep(slot - now);
}

let requestCount = 0;

async function cma(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const headers = {
    api_key: CS_API_KEY,
    authorization: CS_MANAGEMENT_TOKEN,
    'Content-Type': 'application/json',
  };
  if (CS_BRANCH) headers.branch = CS_BRANCH;

  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    requestCount++;
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await backoff(attempt, null, `network error: ${err.message}`);
      continue;
    }

    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const body = await res.text();
      throw new Error(`CMA ${res.status} for ${url.pathname}${url.search}: ${body}`);
    }
    await backoff(attempt, res.headers.get('retry-after'), `HTTP ${res.status}`);
  }
}

async function backoff(attempt, retryAfter, reason) {
  const fromHeader = Number(retryAfter) * 1000;
  const wait = Number.isFinite(fromHeader) && fromHeader > 0
    ? fromHeader
    : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250;
  console.warn(`  ${reason}, retrying in ${Math.round(wait)} ms`);
  // Push everyone back so the whole client slows down, not just this request.
  nextSlot = Math.max(nextSlot, Date.now() + wait);
  await sleep(wait);
}

// ---------------------------------------------------------------------------
// Schema handling: find the HTML field wherever it lives (top level, groups,
// global fields, modular blocks).
// ---------------------------------------------------------------------------
const globalFieldCache = new Map();

async function getGlobalFieldSchema(uid) {
  if (!globalFieldCache.has(uid)) {
    globalFieldCache.set(uid, cma(`/global_fields/${uid}`).then((r) => r.global_field.schema));
  }
  return globalFieldCache.get(uid);
}

const isTarget = (field) =>
  field.uid === HTML_FIELD ||
  field.display_name?.trim().toLowerCase() === HTML_FIELD.trim().toLowerCase();

// Resolves global field references so the schema can be walked synchronously.
// Returns true if the target field exists anywhere in the schema.
async function prepareSchema(schema) {
  let found = false;
  for (const field of schema) {
    if (isTarget(field)) found = true;

    if (field.data_type === 'global_field' && !field.schema) {
      field.schema = await getGlobalFieldSchema(field.reference_to);
    }
    if (field.schema && (await prepareSchema(field.schema))) found = true;

    for (const block of field.blocks ?? []) {
      if (!block.schema && block.reference_to) {
        block.schema = await getGlobalFieldSchema(block.reference_to);
      }
      if (block.schema && (await prepareSchema(block.schema))) found = true;
    }
  }
  return found;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Collects { path, html } for every value of the target field in an entry.
function collectHtml(data, schema, path, out) {
  if (!data || typeof data !== 'object') return;
  for (const field of schema) {
    const value = data[field.uid];
    if (value == null) continue;
    const fieldPath = path ? `${path}.${field.uid}` : field.uid;

    if (isTarget(field)) {
      asArray(value).forEach((html, i) => {
        if (typeof html === 'string') {
          out.push({ path: Array.isArray(value) ? `${fieldPath}[${i}]` : fieldPath, html });
        }
      });
    }

    if (field.data_type === 'group' || field.data_type === 'global_field') {
      if (Array.isArray(value)) {
        value.forEach((item, i) => collectHtml(item, field.schema, `${fieldPath}[${i}]`, out));
      } else {
        collectHtml(value, field.schema, fieldPath, out);
      }
    } else if (field.data_type === 'blocks') {
      asArray(value).forEach((item, i) => {
        for (const block of field.blocks ?? []) {
          if (item?.[block.uid] && block.schema) {
            collectHtml(item[block.uid], block.schema, `${fieldPath}[${i}].${block.uid}`, out);
          }
        }
      });
    }
  }
}

function findAnchors(entry, schema) {
  const values = [];
  collectHtml(entry, schema, '', values);
  const hits = [];
  for (const { path, html } of values) {
    const anchors = html.match(ANCHOR_RE);
    if (anchors) hits.push({ path, anchorCount: anchors.length, anchors });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function scanLocale(locale, schema) {
  const params = { locale, limit: PAGE_SIZE, include_count: true, asc: 'created_at' };
  const first = await cma(`/content_types/${CONTENT_TYPE_UID}/entries`, { ...params, skip: 0 });
  const total = first.count ?? first.entries.length;

  const pages = [first];
  const remaining = [];
  for (let skip = PAGE_SIZE; skip < total; skip += PAGE_SIZE) {
    remaining.push(cma(`/content_types/${CONTENT_TYPE_UID}/entries`, { ...params, skip }));
  }
  pages.push(...(await Promise.all(remaining)));

  const results = [];
  let localized = 0;
  for (const page of pages) {
    for (const entry of page.entries) {
      // Unlocalized entries come back as the fallback-locale version; skip them
      // so each hit is reported only for the locale that actually holds it.
      if (entry.locale !== locale) continue;
      localized++;
      const hits = findAnchors(entry, schema);
      if (hits.length) {
        results.push({
          entry_uid: entry.uid,
          locale,
          title: entry.title ?? '',
          version: entry._version,
          fields: hits,
        });
      }
    }
  }
  console.log(`  ${locale}: ${localized} localized entries, ${results.length} with anchors`);
  return results;
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function main() {
  const started = Date.now();
  console.log(`CMA host: ${CS_CMA_HOST}  |  rate limit: ${RPS} req/s  |  content type: ${CONTENT_TYPE_UID}`);

  const { content_type } = await cma(`/content_types/${CONTENT_TYPE_UID}`);
  const schema = content_type.schema;
  if (!(await prepareSchema(schema))) {
    throw new Error(`Field "${HTML_FIELD}" not found in content type "${CONTENT_TYPE_UID}"`);
  }

  const { locales } = await cma('/locales');
  const codes = locales.map((l) => l.code);
  console.log(`Locales: ${codes.join(', ')}`);

  const results = [];
  for (const code of codes) {
    results.push(...(await scanLocale(code, schema)));
  }

  mkdirSync(new URL('output/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonFile = new URL(`output/anchor-entries-${stamp}.json`, import.meta.url);
  const csvFile = new URL(`output/anchor-entries-${stamp}.csv`, import.meta.url);

  writeFileSync(jsonFile, JSON.stringify(results, null, 2));
  const rows = [['entry_uid', 'locale', 'title', 'version', 'field_path', 'anchor_count']];
  for (const r of results) {
    for (const f of r.fields) {
      rows.push([r.entry_uid, r.locale, r.title, r.version, f.path, f.anchorCount]);
    }
  }
  writeFileSync(csvFile, rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n');

  const uniqueEntries = new Set(results.map((r) => r.entry_uid)).size;
  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s, ${requestCount} requests.\n` +
      `${results.length} entry/locale pairs (${uniqueEntries} unique entries) contain anchors.\n` +
      `  ${jsonFile.pathname}\n  ${csvFile.pathname}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
