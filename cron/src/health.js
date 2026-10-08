// Lightweight native health checks. Browser and deployed-asset comparison stay
// in the GitHub monitor; no credentials or mutations needed for these reads.
export async function checkSite(siteUrl) {
  if (!siteUrl) throw new Error('Missing SITE_URL');
  const probes = [
    ['/', async r => (r.headers.get('content-type') || '').includes('text/html') && /Lock\s*League/i.test(await r.text())],
    ['/api/config', async r => {const d=await r.json();return Number(d.season)>=2026 && Number.isInteger(Number(d.week)) && Number(d.week)>=0 && Number(d.week)<=22;}],
    ['/api/scores', async r => {const d=await r.json();return Array.isArray(d.games) && d.games.every(g=>g.home && g.away);}],
  ];
  const results=await Promise.all(probes.map(async([path,valid])=>{
    try {
      const r=await fetch(new URL(path,siteUrl),{signal:AbortSignal.timeout(15000),redirect:'manual'});
      if(!r.ok || !await valid(r)) throw new Error(`Invalid response (${r.status})`);
      return {path,ok:true};
    } catch(e){return {path,ok:false,error:e.message};}
  }));
  if(results.some(r=>!r.ok)) throw new Error(JSON.stringify(results));
  return results;
}
