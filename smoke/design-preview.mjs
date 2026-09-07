import {readFileSync, mkdirSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
let chromium;
try { ({chromium}=await import('playwright')); } catch {
 const globalRoot=execSync('npm root -g').toString().trim();
 ({chromium}=await import(pathToFileURL(globalRoot+'/playwright/index.mjs').href));
}
// Isolated browser fixtures: no production picks, payments, or notifications are written.
const dir=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(process.argv[2] || '/tmp/lock-league-design');
mkdirSync(output,{recursive:true});
const b=await chromium.launch();
for(const width of [375,390,844,1440]){
 const p=await b.newPage({viewport:{width,height:920}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.clock.setFixedTime(new Date('2026-09-13T19:00:00Z'));
 await p.route('**/api/**',r=>r.fulfill({json:{}}));
 await p.goto('file://'+dir+'/public/index.html',{waitUntil:'networkidle'});
 await p.evaluate(data=>{
 DATA=data;state.user={id:5,name:'Jacob'};state.serverConfig={season:2026,week:1,cutoff:'2026-09-13T17:00:00Z'};
 const names=['Brayden','Chase','Chris','Jack','Jacob','Jared','Mason','Tyler'];
 const results=[['W','L','L','W',''],['W','L','L','',''],['W','L','','',''],['W','W','W','',''],['W','L','W','',''],['L','L','','',''],['W','W','W','L',''],['L','L','L','','']];
 const rows=names.flatMap((name,i)=>BET_TYPES_ORDER.map((bt,j)=>({member_name:name,member_id:i+1,season:2026,week:1,bet_type:bt,pick_text:bt==='Under'?'Chicago Bears / Carolina Panthers U47.5':bt==='Super Lock'?'Jalen Hurts O224.5 Passing Yards':'Sample selection',result:results[i][j],price:j===2?-118:-110,book:'fanduel'})));
 mergeLiveSeason(rows);normalizeRecords(DATA);state.season='2026';
 const game={away:'Chicago Bears',home:'Carolina Panthers',kickoff:'2026-09-13T17:00Z',books:{fanduel:{updated:new Date().toISOString(),spread:{fav:'Carolina Panthers',line:-2.5,favPrice:-110,dogPrice:-110},total:{point:47.5,overPrice:-102,underPrice:-120}},draftkings:{updated:new Date().toISOString(),spread:{fav:'Carolina Panthers',line:-3,favPrice:-110,dogPrice:-110},total:{point:46.5,overPrice:-118,underPrice:-102}}}};
 state.thisWeekData={games:[game,{...game,away:'Dallas Cowboys',home:'Philadelphia Eagles',kickoff:'2026-09-13T20:25Z'}],source:'sharpapi',fetched_at:new Date().toISOString()};
 currentMyPicks=Object.fromEntries(rows.filter(p=>p.member_name==='Jacob').slice(0,3).map(p=>[p.bet_type,p]));
 const members=names.map((name,i)=>({member_id:i+1,name,live:{W:3,L:1,P:0,fW:2,fL:1,fP:0,pending:1},picks:BET_TYPES_ORDER.map((bt,j)=>({bet_type:bt,kind:'pick',pick_text:rows[i*5+j].pick_text,price:rows[i*5+j].price,book:'fanduel',status:j===1?'lose':j<3?'win':'pending',final:j<3,state:j<3?'post':'in',game_key:j===4?'Dallas Cowboys@Philadelphia Eagles':'Chicago Bears@Carolina Panthers',score:{away:j===4?'Dallas Cowboys':'Chicago Bears',home:j===4?'Philadelphia Eagles':'Carolina Panthers',away_score:j===4?17:17,home_score:j===4?21:14},detail:j===4?'Q4 · 11:06':'Q3 · 08:42',...(j===4?{prop:{market:'passing_yards',player:'Jalen Hurts',line:224.5,side:'over'}}:{})}))}));
 state.pot={season:2026,weekly:{prize:40}};
 state.warRoom={season:2026,week:1,revealed:true,anyLive:true,members,source_updated_at:new Date().toISOString()};
 wrGameCache['Dallas Cowboys@Philadelphia Eagles']={ts:Date.now(),data:{found:true,away:{name:'Dallas Cowboys',score:17},home:{name:'Philadelphia Eagles',score:21},state:'in',detail:'Q4 · 11:06',source_updated_at:new Date().toISOString(),stats_updated_at:new Date().toISOString(),players:[{name:'Jalen Hurts',markets:{passing_yards:{actual:186,unit:'pass yds'}}}]}};
 },JSON.parse(readFileSync(dir+'/public/data/seasons.json','utf8')));
 for(const [view,name] of [['standings','home'],['thisweek','picks'],['warroom','live']]){
 await p.evaluate(view=>{state.view=view;syncNavActive();renderUserArea();document.getElementById('root').innerHTML=view==='standings'?renderStandings():view==='thisweek'?renderThisWeek():renderWarRoom();document.getElementById('root').scrollTop=0;},view);
 await p.waitForTimeout(350);await p.screenshot({path:`${output}/${name}-${width}.png`});
 const overflows=await p.evaluate(()=>document.getElementById('root').scrollWidth>document.getElementById('root').clientWidth+1);
 if(overflows) throw new Error(`Overflow ${view} at ${width}px`);
 console.log(JSON.stringify({width,view,...await p.evaluate(()=>({overflow:document.getElementById('root').scrollWidth>document.getElementById('root').clientWidth,firstGame:document.querySelector('.game-card')?.getBoundingClientRect().top,text:document.getElementById('root').innerText.slice(0,160)}))}));
 }
 await p.locator('.bottom-nav-link[data-view=more]').evaluate(el=>el.click());
 await p.waitForTimeout(50);
 if(await p.locator('.more-list [data-go]').count()!==3) throw new Error('Missing secondary navigation');
 if(await p.locator('#mobile-nav .bottom-nav-link').count()!==4) throw new Error('Expected four mobile destinations');
 if(errors.length) throw new Error(errors.join(' | '));
 console.log({errors});await p.close();
}
await b.close();
