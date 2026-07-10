import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('data/vendor_crawl.json','utf8'));
const uniq = a => [...new Set(a)];
const grab = (t, re, n=15) => uniq((t.match(re)||[]).map(s=>s.trim())).slice(0,n);

const out = d.map(v => {
  const text = (v.pages||[]).map(p=>p.markdown||'').join('\n').replace(/\s+/g,' ');
  const T = text.toLowerCase();
  const emails = grab(text, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, 6);
  const phones = grab(text, /(?:\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}/g, 6);
  const prices = grab(text, /(?:S\$|SGD\s?|\$)\s?\d{2,4}(?:\.\d{2})?/gi, 20);
  const ageRanges = grab(text, /\b\d{1,2}\s?(?:-|to|–|—)\s?\d{1,2}\s?(?:months?|mths?|years?|yrs?|y\/?o)\b/gi);
  const ageSingles = grab(text, /\b(?:from\s?)?\d{1,2}\s?(?:months?|mths?|years?|yrs?)\s?(?:old|and\s?up|\+)?\b/gi);
  const ageWords = grab(T, /\b(?:newborn|infant|baby|babies|toddler|preschool|pre-?school|kindergarten|primary)\b/gi, 8);
  const days = grab(T, /\b(?:mon|tues?|wed|thur?s?|fri|sat|sun)(?:day)?\b/gi, 8);
  const times = grab(text, /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, 20);
  const durations = grab(text, /\b\d{2,3}\s?(?:-|to)?\s?\d{0,3}\s?(?:min|mins|minutes|hour|hrs?)\b/gi, 8);
  const packages = grab(T, /\b(?:free\s)?trial|term|bundle|package|drop[- ]?in|per class|per term|membership|\d+[- ]?class(?:es)?|casual|block of \d+/gi, 12);
  const languages = grab(T, /\b(?:english|mandarin|chinese|malay|tamil|bilingual)\b/gi, 6);
  const amenities = grab(T, /\b(?:stroller|pram|parking|wheelchair|nursing room|diaper)\b/gi, 6);
  const capacity = grab(T, /\b(?:max(?:imum)?|up to|limited to)\s?\d{1,2}\s?(?:children|kids|pax|participants|spots?)?\b/gi, 6);
  return {
    Name: v.Name, Website: v.Website, Category: v.Category, Rating: v.Rating, Reviews: v.Reviews,
    Address: v.Address, Latitude: v.Latitude, Longitude: v.Longitude, 'Business Status': v['Business Status'],
    _pages: (v.pages||[]).length, _chars: text.length,
    extracted: { emails, phones, prices, ageRanges, ageSingles, ageWords, days, times, durations, packages, languages, amenities, capacity },
  };
});
fs.writeFileSync('data/vendor_enriched.json', JSON.stringify(out,null,1));

// coverage summary (no content dump)
const has = f => out.filter(v=>v.extracted[f]?.length).length;
console.log(`vendors: ${out.length}`);
for (const f of ['emails','phones','prices','ageRanges','ageSingles','ageWords','days','times','packages','languages','amenities','capacity'])
  console.log(`  ${f.padEnd(11)} present for ${String(has(f)).padStart(2)} vendors`);
console.log('\n-- 3 samples (what regex pulled) --');
for (const v of out.filter(v=>v._chars>2000).slice(0,3)) {
  const e=v.extracted;
  console.log(`\n### ${v.Name}`);
  console.log(`  prices:  ${e.prices.slice(0,6).join(' | ')||'-'}`);
  console.log(`  ages:    ${[...e.ageRanges,...e.ageSingles].slice(0,5).join(' | ')||'-'}`);
  console.log(`  days:    ${e.days.join(', ')||'-'}    times: ${e.times.slice(0,5).join(', ')||'-'}`);
  console.log(`  packages:${e.packages.slice(0,5).join(' | ')||'-'}`);
  console.log(`  email:   ${e.emails[0]||'-'}   phone: ${e.phones[0]||'-'}`);
}
