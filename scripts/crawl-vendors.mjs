import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local','utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
);
const TOKEN = process.env.APIFY_API_TOKEN || env.APIFY_API_TOKEN;
if (!TOKEN) { console.error('No APIFY_API_TOKEN'); process.exit(1); }
const ACTOR = 'apify~website-content-crawler';

// tunables (kept shallow so no single site goes deep / gets stuck)
const POOL = 4;               // simultaneous crawl runs
const MAX_PAGES = 5;          // pages per site (homepage + a few subpages)
const MAX_DEPTH = 1;          // one level of links only
const RUN_TIMEOUT = 260;      // longer, for slow/JS sites on the gap-fill pass      // secs; Apify aborts a stuck run

const vendors = JSON.parse(fs.readFileSync('data/vendors.json','utf8'));
let prior = [];
try { prior = JSON.parse(fs.readFileSync('data/vendor_crawl.json','utf8')); } catch {}
const priorByName = Object.fromEntries(prior.map(v => [v['Name'], v]));
const host = u => { try { return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); } catch { return ''; } };
const api = (path, opts={}) =>
  fetch(`https://api.apify.com/v2${path}${path.includes('?')?'&':'?'}token=${TOKEN}`, opts).then(r=>r.json());
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function crawlOne(v){
  const url = (v.Website||'').trim();
  if (!/^https?:\/\//.test(url)) return { ...v, pages: [], _skip:'no-url' };
  const input = {
    startUrls: [{ url }],
    crawlerType: 'playwright:adaptive',
    maxCrawlDepth: MAX_DEPTH,
    maxCrawlPages: MAX_PAGES,
    maxConcurrency: 3,
    saveMarkdown: true, saveHtml: false,
    proxyConfiguration: { useApifyProxy: true },
  };
  try {
    const run = await api(`/acts/${ACTOR}/runs?timeout=${RUN_TIMEOUT}&memory=2048`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(input),
    });
    const runId = run?.data?.id, dsId = run?.data?.defaultDatasetId;
    if (!runId) return { ...v, pages: [], _err: JSON.stringify(run?.error||run).slice(0,120) };
    let status='RUNNING', n=0;
    while (['READY','RUNNING'].includes(status) && n<22) {
      await sleep(8000);
      status = (await api(`/actor-runs/${runId}`))?.data?.status; n++;
    }
    const items = await api(`/datasets/${dsId}/items?clean=true&format=json`);
    const pages = (Array.isArray(items)?items:[]).map(p=>({
      url: p.url, title: p.metadata?.title||'', description: p.metadata?.description||'',
      markdown: p.markdown || p.text || '',
    }));
    return { ...v, _host: host(url), _status: status, pages };
  } catch (e) {
    return { ...v, pages: [], _err: String(e).slice(0,120) };
  }
}

// simple concurrency pool
const out = new Array(vendors.length);
let idx = 0, done = 0;
async function runner(){
  while (idx < vendors.length){
    const i = idx++;
    const existing = priorByName[vendors[i]['Name']];
    let r;
    if (existing && (existing.pages||[]).length) {
      r = existing;                       // keep good result, skip re-crawl
    } else {
      r = await crawlOne(vendors[i]);
      for (let a=2; a<=3 && !(r.pages||[]).length; a++){ await sleep(4000*a); r = await crawlOne(vendors[i]); }
    }
    out[i] = r; done++;
    const n=r.pages?.length||0, ch=(r.pages||[]).reduce((a,p)=>a+(p.markdown||'').length,0);
    console.log(`[${done}/${vendors.length}] ${String(n).padStart(2)}p ${String(ch).padStart(7)}ch ${r._err?('ERR '+r._err):r._status||''}  ${r['Name']}`);
    fs.writeFileSync('data/vendor_crawl.json', JSON.stringify(out.filter(Boolean),null,1)); // incremental save
  }
}
console.log(`Crawling ${vendors.length} sites, pool=${POOL}, ${MAX_PAGES}pages/site, depth=${MAX_DEPTH}, timeout=${RUN_TIMEOUT}s`);
await Promise.all(Array(POOL).fill(0).map(runner));

const withPages = out.filter(v=>v?.pages?.length).length;
const totalPages = out.reduce((a,v)=>a+(v?.pages?.length||0),0);
console.log(`\nDONE -> data/vendor_crawl.json | vendors=${out.length} withPages=${withPages} totalPages=${totalPages}`);
