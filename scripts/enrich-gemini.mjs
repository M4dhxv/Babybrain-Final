import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const LIMIT = process.env.LIMIT ? +process.env.LIMIT : Infinity;
const POOL = 5;
const d = JSON.parse(fs.readFileSync('data/vendor_crawl.json','utf8'));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const SCHEMA = `Return ONLY JSON (no prose) with this shape:
{"activity_types":[string], "target_age":{"min_months":number|null,"max_months":number|null,"text":string},
"classes":[{"name":string,"schedule":string,"duration":string,"location":string}],
"locations":[string], "packages":[{"name":string,"price_sgd":number|null,"description":string}],
"price_from_sgd":number|null, "email":string|null, "phone":string|null,
"languages":[string], "stroller_accessible":boolean|null, "parking":string|null,
"accompaniment":string|null, "capacity":string|null, "summary":string}
Rules: use ONLY facts stated in the text; if unknown use null or []. Do not invent prices/ages. summary = 1-2 sentences on the benefit for the child. Convert ages to months where possible.`;

async function extract(v){
  const text = (v.pages||[]).map(p=>`# ${p.title}\n${p.markdown||''}`).join('\n\n').slice(0,8000);
  if (text.length < 150) return { ...pick(v), enriched:null, _note:'no content' };
  const prompt = `Business: ${v.Name} (category: ${v.Category}).\nExtract structured info about their kids' classes/activities from this website content.\n\n${SCHEMA}\n\n--- WEBSITE CONTENT ---\n${text}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  for (let attempt=1; attempt<=4; attempt++){
    try {
      const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        contents:[{parts:[{text:prompt}]}],
        generationConfig:{responseMimeType:'application/json',temperature:0.1,maxOutputTokens:8192,thinkingConfig:{thinkingBudget:0}},
      })});
      if (r.status===429 || r.status===503){ await sleep(3000*attempt); continue; }
      const j = await r.json();
      if (j.error) return { ...pick(v), enriched:null, _err:`${j.error.code} ${j.error.message}`.slice(0,80) };
      const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let parsed=null; try{ parsed=JSON.parse(raw); }catch{ parsed={_parseError:raw.slice(0,120)}; }
      return { ...pick(v), enriched:parsed };
    } catch(e){ if(attempt===4) return { ...pick(v), enriched:null, _err:String(e).slice(0,80) }; await sleep(2000*attempt); }
  }
  return { ...pick(v), enriched:null, _err:'rate-limited' };
}
const pick = v => ({ Name:v.Name, Website:v.Website, Category:v.Category, Rating:v.Rating, Reviews:v.Reviews, Address:v.Address, Latitude:v.Latitude, Longitude:v.Longitude, 'Business Status':v['Business Status'] });

const targets = d.slice(0, LIMIT);
const out = new Array(targets.length); let i=0, done=0;
async function runner(){ while(i<targets.length){ const k=i++; out[k]=await extract(targets[k]); done++;
  const e=out[k].enriched; console.log(`[${done}/${targets.length}] ${e?'OK ':(out[k]._err?'ERR '+out[k]._err:'-- ')} ${out[k].Name}`);
  fs.writeFileSync(process.env.OUTFILE||'data/vendor_enriched.json', JSON.stringify(out.filter(Boolean),null,1)); } }
await Promise.all(Array(Math.min(POOL,targets.length)).fill(0).map(runner));
const ok = out.filter(v=>v.enriched && !v.enriched._parseError).length;
console.log(`\nmodel=${MODEL} vendors=${out.length} enriched=${ok}`);
