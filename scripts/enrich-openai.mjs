#!/usr/bin/env node
/**
 * Turn the raw Apify crawl into structured records, using the OpenAI API.
 *
 *   node scripts/enrich-openai.mjs                  # all vendors, resumable
 *   LIMIT=5 node scripts/enrich-openai.mjs          # first 5 (cheap smoke test)
 *   FORCE=1 node scripts/enrich-openai.mjs          # re-do vendors already done
 *
 *   data/vendor_crawl.json  ->  data/vendor_openai.json  ->  scripts/import-vendors.mjs
 *
 * Why this exists alongside enrich-gemini.mjs:
 *
 *  1. The Gemini run never finished — of 71 crawled vendors only 39 were
 *     attempted, 22 of those came back rate-limited and 15 produced usable
 *     output, yielding 14 classes in total. That is why a batch of providers
 *     still have no published listings.
 *  2. Its output shape doesn't match what import-vendors.mjs reads. Gemini
 *     emits `{Name, enriched:{...}}` with `locations` as plain strings and a
 *     freeform `schedule`; the importer wants a flat record with `name`,
 *     `locations[{name,address,postal_code}]`, `classes[{days[],times[]}]`,
 *     plus `confidence`, `bb_vendor_category` and `activities_categories`,
 *     which that prompt never asked for.
 *
 * So this script emits *exactly* the importer's input shape, and uses
 * Structured Outputs (a strict JSON schema enforced by the API) so the result
 * can't come back as unparseable prose — the other failure mode in the old run.
 *
 * Needs OPENAI_API_KEY in .env.local. Override the model with OPENAI_MODEL.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

process.loadEnvFile('.env.local');

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error(
    'OPENAI_API_KEY is not set in .env.local — add it and re-run.\n' +
      'Nothing was written and no requests were made.'
  );
  process.exit(1);
}
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const INFILE = process.env.INFILE || 'data/vendor_crawl.json';
const OUTFILE = process.env.OUTFILE || 'data/vendor_openai.json';
const LIMIT = process.env.LIMIT ? +process.env.LIMIT : Infinity;
const FORCE = !!process.env.FORCE;
const POOL = +(process.env.POOL || 4);
/* Accuracy over frugality: at 120k chars (~30k tokens) nothing in the current
 * crawl is truncated at all — the largest vendor is 49k chars — and a full run
 * still costs well under a dollar. The trimming below only exists as a safety
 * net for future crawls of much larger sites. */
const MAX_CHARS = +(process.env.MAX_CHARS || 120000);

/* Slugs must match the live taxonomy. `art-creativity` and `gymnastics` were
 * merged away by migration 00031, so anything emitting them now falls back to
 * the default category instead of landing where it belongs. */
const ACTIVITY_CATEGORIES = [
  'music', 'sensory-play', 'movement', 'swimming',
  'early-learning', 'parent-baby', 'playspaces',
  'community-events', 'holiday-camps',
];
const VENDOR_CATEGORIES = [
  'baby-toddler-classes', 'playspaces', 'camps-holiday',
  'community-events', 'mum-bub-exercise', 'other',
];

const S = {
  str: { type: 'string' },
  nstr: { type: ['string', 'null'] },
  nnum: { type: ['number', 'null'] },
};

/* Strict mode requires every property listed in `required` and
 * additionalProperties:false at every level. Optionality is expressed by
 * allowing null, not by omitting the key. */
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SCHEMA = obj({
  name: S.str,
  summary: S.str,
  // The model's own view of whether the page was really about kids' activities.
  // import-vendors.mjs drops anything marked low.
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  permanently_closed: { type: 'boolean' },
  bb_vendor_category: { type: 'string', enum: VENDOR_CATEGORIES },
  activities_categories: { type: 'array', items: { type: 'string', enum: ACTIVITY_CATEGORIES } },
  target_age: obj({ min_months: S.nnum, max_months: S.nnum, text: S.nstr }),
  classes: {
    type: 'array',
    items: obj({
      name: S.str,
      days: { type: 'array', items: { type: 'string' } },
      times: { type: 'array', items: { type: 'string' } },
      duration: S.nstr,
      location: S.nstr,
      price_sgd: S.nnum,
      age_text: S.nstr,
    }),
  },
  locations: {
    type: 'array',
    items: obj({ name: S.nstr, address: S.nstr, postal_code: S.nstr }),
  },
  packages: {
    type: 'array',
    items: obj({ name: S.str, price_sgd: S.nnum, credits: S.nnum, description: S.nstr }),
  },
  price_from_sgd: S.nnum,
  email: S.nstr,
  phone: S.nstr,
  whatsapp: S.nstr,
  booking_url: S.nstr,
  socials: obj({ instagram: S.nstr, facebook: S.nstr }),
  languages: { type: 'array', items: { type: 'string' } },
});

const SYSTEM = `You extract structured listings for BabyBrain, a Singapore directory of children's activities.

Rules:
- Use ONLY facts stated in the supplied website text. Never invent prices, ages, addresses or schedules.
- Unknown scalar -> null. Unknown list -> [].
- "classes" means distinct bookable offerings for children (a class, course, term, open-play session or camp). Do NOT list adult-only classes, staff, venues or blog posts as classes.
- If the business only offers adult classes (e.g. adult yoga or pilates with no child or parent-and-baby option), return classes: [] and confidence: "low".
- Convert ages to months (2 years -> 24). Put the original wording in target_age.text and each class's age_text.
- postal_code is the 6-digit Singapore code only.
- price_sgd is a number in SGD, no currency symbol. Use the lowest advertised price when a range is given.
- summary: 1-2 plain sentences on what a parent gets. No marketing language.
- confidence: "high" if the page clearly describes children's activities; "medium" if partly inferred; "low" if the content is thin, irrelevant, or not about children.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Pages that never contain listing facts. Left in, they burn the character
 * budget before the useful pages are reached — on the first smoke test Lucy
 * Sparkles' privacy and safeguarding pages were consuming the budget while her
 * class schedule and contact details sat past the cut. */
const BOILERPLATE = /privacy|terms|safeguard|cookie|refund-policy|disclaimer|sitemap/i;
/* Pages most likely to hold classes, times, prices and contact details. */
const VALUABLE = /class|course|schedule|timetable|price|pricing|book|register|enrol|contact|location|venue|about|program|camp|lesson/i;

const rank = (p) => {
  const s = `${p.url || ''} ${p.title || ''}`;
  if (BOILERPLATE.test(s)) return 2;
  if (VALUABLE.test(s)) return 0;
  return 1;
};

/* Keep the beginning and the end when a page has to be trimmed. Contact
 * details, addresses and opening hours almost always live in the footer, so
 * head-only truncation reliably loses exactly what we most need — that's why
 * the first run returned no emails or phone numbers for any vendor. */
function squeeze(text, budget) {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return `${text.slice(0, head)}\n\n…[trimmed]…\n\n${text.slice(-tail)}`;
}

function contentFor(v) {
  const pages = [...(v.pages || [])]
    .filter((p) => (p.markdown || '').trim().length > 40)
    .sort((a, b) => rank(a) - rank(b));

  const bodies = pages.map((p) => ({
    title: p.title || p.url || '',
    body: (p.markdown || '').replace(/\n{3,}/g, '\n\n').trim(),
  }));

  // Everything fits — send it whole. This is the normal path for every vendor
  // in the current crawl, so nothing is guessed from a partial page.
  const total = bodies.reduce((n, p) => n + p.body.length + p.title.length + 4, 0);
  if (total <= MAX_CHARS) {
    return bodies.map((p) => `## ${p.title}\n${p.body}`).join('\n\n');
  }

  // Oversized site: ration the budget, highest-value pages first, keeping each
  // page's head and tail.
  const out = [];
  let left = MAX_CHARS;
  for (const p of bodies) {
    if (left <= 500) break;
    const slice = squeeze(p.body, Math.max(1200, Math.floor(left * 0.6)));
    const block = `## ${p.title}\n${slice}`;
    out.push(block);
    left -= block.length;
  }
  return out.join('\n\n').slice(0, MAX_CHARS);
}

async function extract(v) {
  const text = contentFor(v);
  const base = {
    name: v.Name,
    website: v.Website || null,
    address: v.Address || null,
    latitude: v.Latitude === '' ? null : Number(v.Latitude),
    longitude: v.Longitude === '' ? null : Number(v.Longitude),
    rating: v.Rating === '' ? null : Number(v.Rating),
    reviews: v.Reviews === '' ? null : Number(v.Reviews),
  };
  if (text.length < 150) return { ...base, confidence: 'low', _note: 'no crawled content' };

  const body = {
    model: MODEL,
    // Deterministic extraction: we want the same answer for the same page.
    temperature: 0,
    // Headroom for a vendor with many classes; without it a long listing can
    // hit the default cap and come back as finish_reason:'length'.
    max_tokens: 8000,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Business: ${v.Name}\nWebsite: ${v.Website || 'unknown'}\nGoogle category: ${v.Category || 'unknown'}\n\n--- WEBSITE CONTENT ---\n${text}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'vendor_listing', strict: true, schema: SCHEMA },
    },
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // 429/5xx are transient. Honour Retry-After when the API sends one,
      // otherwise back off exponentially — the previous run died here.
      if (r.status === 429 || r.status >= 500) {
        const wait = Number(r.headers.get('retry-after')) * 1000 || 2000 * 2 ** (attempt - 1);
        if (attempt === 5) return { ...base, confidence: 'low', _err: `${r.status} after 5 tries` };
        await sleep(Math.min(wait, 60000));
        continue;
      }

      const j = await r.json();
      if (j.error) return { ...base, confidence: 'low', _err: `${j.error.type}: ${j.error.message}`.slice(0, 160) };

      const choice = j.choices?.[0];
      // A strict-schema response can still be cut short by the token cap.
      if (choice?.finish_reason === 'length') {
        return { ...base, confidence: 'low', _err: 'truncated — lower MAX_CHARS' };
      }
      if (choice?.message?.refusal) {
        return { ...base, confidence: 'low', _err: `refusal: ${choice.message.refusal}`.slice(0, 160) };
      }

      const parsed = JSON.parse(choice.message.content);
      // Strict mode requires every key to be present, so "nothing found" comes
      // back as a row of nulls rather than an empty list. Drop those.
      parsed.locations = (parsed.locations || []).filter((l) => l && (l.name || l.address || l.postal_code));
      parsed.classes = (parsed.classes || []).filter((c) => c && c.name);
      parsed.packages = (parsed.packages || []).filter((p) => p && p.name);
      return {
        ...base,
        ...parsed,
        // Never let the model overwrite facts we already hold from Places.
        name: v.Name || parsed.name,
        website: base.website || parsed.booking_url,
        address: base.address || parsed.locations?.[0]?.address || null,
        latitude: base.latitude,
        longitude: base.longitude,
        _tokens: j.usage?.total_tokens ?? null,
      };
    } catch (e) {
      if (attempt === 5) return { ...base, confidence: 'low', _err: String(e).slice(0, 160) };
      await sleep(2000 * attempt);
    }
  }
  return { ...base, confidence: 'low', _err: 'exhausted retries' };
}

// ---- run ----
const crawl = JSON.parse(readFileSync(INFILE, 'utf8'));

// Resume: keep whatever already succeeded so a crash or a rate-limit wall
// doesn't cost the whole run again.
const prior = existsSync(OUTFILE) ? JSON.parse(readFileSync(OUTFILE, 'utf8')) : [];
const done = new Map(prior.filter((r) => !r._err).map((r) => [r.name, r]));

const targets = crawl.slice(0, LIMIT).filter((v) => FORCE || !done.has(v.Name));
console.log(
  `${crawl.length} crawled · ${done.size} already done · ${targets.length} to process · model=${MODEL}`
);
if (!targets.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

const results = new Map(done);
let i = 0, finished = 0, tokens = 0;

const save = () => writeFileSync(OUTFILE, JSON.stringify([...results.values()], null, 1));

async function worker() {
  while (i < targets.length) {
    const v = targets[i++];
    const rec = await extract(v);
    results.set(rec.name, rec);
    tokens += rec._tokens || 0;
    finished++;
    const status = rec._err ? `ERR ${rec._err}` : rec._note ? rec._note : `${(rec.classes || []).length} classes · ${rec.confidence}`;
    console.log(`[${finished}/${targets.length}] ${rec.name} — ${status}`);
    save(); // checkpoint every record
  }
}

await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, worker));
save();

const all = [...results.values()];
const usable = all.filter((r) => !r._err && r.confidence !== 'low');
console.log(
  `\nWrote ${OUTFILE}` +
    `\n  total records : ${all.length}` +
    `\n  usable        : ${usable.length}` +
    `\n  classes found : ${usable.reduce((n, r) => n + (r.classes || []).length, 0)}` +
    `\n  errored       : ${all.filter((r) => r._err).length}` +
    `\n  tokens used   : ${tokens}` +
    `\n\nNext: node scripts/import-vendors.mjs ${OUTFILE}   (dry run; add --live to write)`
);
