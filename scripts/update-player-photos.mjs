// Refresh verified ESPN roster portraits. No API key or per-player requests.
import {readFileSync,writeFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const teams=JSON.parse(html.match(/const TEAM_ABBR = (\{[\s\S]*?\});/)[1].replace(/,\s*}/g,'}'));
const players=new Map();
const queue=Object.entries(teams);
await Promise.all(Array.from({length:4},async()=>{
 while(queue.length){
  const [team,abbr]=queue.shift();
  const response=await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${abbr}/roster`,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`${team}: ${response.status}`);
  const data=await response.json();
  const athletes=(data.athletes||[]).flatMap(group=>group.items||[]);
  if(athletes.length<20)throw Error(`Incomplete roster: ${team}`);
  for(const a of athletes){
   const photo=a.headshot?.href;
   if(!photo||!/^https:\/\/(?:[a-z0-9-]+\.)*espncdn\.com\//i.test(photo)||!a.id||!a.displayName)continue;
   const existing=players.get(a.id);
   if(existing){if(!existing.teams.includes(team))existing.teams.push(team);continue;}
   players.set(a.id,{id:String(a.id),name:a.displayName,teams:[team],photo});
  }
 }
}));
if(players.size<1000)throw Error('Incomplete NFL photo collection; original file preserved');
const data={updated_at:new Date().toISOString(),source:'ESPN team rosters',players:[...players.values()].sort((a,b)=>a.name.localeCompare(b.name))};
writeFileSync(new URL('../public/data/player-photos.json',import.meta.url),JSON.stringify(data));
console.log(`${data.players.length} verified player portraits across ${Object.keys(teams).length} rosters`);
