import assert from 'node:assert/strict';
import {loadChromium} from './playwright.mjs';
import {mkdirSync} from 'node:fs';
const browser=await (await loadChromium()).launch();
mkdirSync('/tmp/lock-league-live-results-shots',{recursive:true});
try {
 for(const width of [375,844,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.route('**/fonts.googleapis.com/**',r=>r.abort());
  await page.goto(new URL('../public/index.html',import.meta.url).href,{waitUntil:'domcontentloaded'});
  const checks=await page.evaluate(()=>{
   const results=[];
   const d={state:'in',away:{name:'Buffalo Bills',score:21},home:{name:'Detroit Lions',score:14},players:[{name:'Josh Allen',markets:{rush_yds:{actual:32,unit:'rush yds'},anytime_td:{actual:1,unit:'TD'}}}]};
   const base={kind:'pick',bet_type:'Super Lock',status:'pending',state:'in',final:false,book:'draftkings',price:-110,prop:{player:'Josh Allen',market:'rush_yds',line:31.5,side:'over'}};
   const check=(name,p,data,tone,label)=>{const r=liveResultPresentation(p,data);results.push([name,r.tone===tone&&r.label===label,JSON.stringify(r)]);};
   check('over reached',base,d,'win','TARGET REACHED · LIVE');
   check('zero line',{...base,prop:{...base.prop,line:0}},d,'win','TARGET REACHED · LIVE');
   check('total Super Lock',{...base,prop:{kind:'total',side:'over',line:34.5},pick_text:'Buffalo Bills / Detroit Lions O34.5'},d,'win','TARGET REACHED · LIVE');
   check('spread Super Lock',{...base,prop:{kind:'spread'},pick_text:'Buffalo Bills -3.5'},d,'neutral','LIVE · IN PROGRESS');
   check('under crossed',{...base,prop:{...base.prop,side:'under'}},d,'lose','OVER LIMIT · LIVE');
   check('under still open',{...base,prop:{...base.prop,side:'under',line:40}},d,'neutral','LIVE · IN PROGRESS');
   check('over not reached',{...base,prop:{...base.prop,line:40}},d,'neutral','LIVE · IN PROGRESS');
   check('on number',{...base,prop:{...base.prop,line:32}},d,'neutral','LIVE · IN PROGRESS');
   check('TD reached',{...base,prop:{...base.prop,market:'anytime_td',line:null,side:'yes'}},d,'win','TARGET REACHED · LIVE');
   check('stale',base,{...d,stale:true},'neutral','LIVE · IN PROGRESS');
   check('missing stats',base,{...d,players:[]},'neutral','LIVE · IN PROGRESS');
   check('duplicate player',base,{...d,players:[...d.players,...d.players]},'neutral','LIVE · IN PROGRESS');
   check('awaiting grade',{...base,state:'post',final:true},d,'neutral','AWAITING GRADE');
   check('pregame',{...base,state:'pre'},d,'neutral','UPCOMING');
   for(const [status,tone,label] of [['win','win','WON'],['lose','lose','LOST'],['push','push','PUSH']]) check('settled '+status,{...base,final:true,status},null,tone,label);
   for(const [bet_type,pick_text,tone,label] of [['Over','BUF / DET O34.5','win','TARGET REACHED · LIVE'],['Under','BUF / DET U34.5','lose','OVER LIMIT · LIVE'],['Under','BUF / DET U54.5','neutral','LIVE · IN PROGRESS'],['Favorite','Buffalo Bills -3.5','neutral','LIVE · IN PROGRESS']]) check(bet_type+pick_text,{...base,bet_type,pick_text,prop:null},d,tone,label);
   state.user={id:5,name:'Jacob'};state.wrMemberId=5;
   const picks=[
    {...base,bet_type:'Favorite',pick_text:'Buffalo Bills -3.5',prop:null,final:true,status:'win',state:'post'},
    {...base,bet_type:'Dog',pick_text:'Detroit Lions +3.5',prop:null,final:true,status:'lose',state:'post'},
    {...base,bet_type:'Over',pick_text:'Buffalo Bills / Detroit Lions O44.5',prop:null},
    {...base,bet_type:'Under',pick_text:'Buffalo Bills / Detroit Lions U34.5',prop:null},
    {...base,pick_text:'Josh Allen O31.5 Rushing Yards'}
   ].map(p=>({...p,game_key:'Buffalo Bills@Detroit Lions',score:{away:'Buffalo Bills',home:'Detroit Lions',away_score:21,home_score:14},detail:p.final?'Final':'Q3 · 08:42'}));
   wrGameCache['Buffalo Bills@Detroit Lions']={ts:Date.now(),data:{...d,found:true,stats_updated_at:new Date().toISOString()}};
   const m={member_id:5,name:'Jacob',live:{fW:1,fL:1,fP:0},picks};
   document.getElementById('root').innerHTML=`<div class="wr-wrap">${renderPersonalLive({week:3,members:[m]})}<div class="wr-grid">${wrChip(picks[0],m)}${wrChip(picks[1],m)}</div></div>`;
   results.push(['completed personal cards kept',document.querySelectorAll('.personal-live-card').length===5]);
   return results;
  });
  for(const [name,passed,detail] of checks) assert.ok(passed,`${width}: ${name}: ${detail}`);
  const colors=await page.locator('.personal-live-card').evaluateAll(cards=>cards.map(c=>({bg:getComputedStyle(c).backgroundColor,bar:getComputedStyle(c.querySelector('.pick-progress-fill')).backgroundColor,label:c.querySelector('.live-result-badge').textContent})));
  assert.notEqual(colors[0].bg,colors[1].bg);assert.notEqual(colors[0].bar,colors[1].bar);assert.notEqual(colors[2].bar,colors[0].bar);
  assert.equal(await page.evaluate(()=>document.getElementById('root').scrollWidth>document.getElementById('root').clientWidth+1),false,'overflow');
  await page.setViewportSize({width,height:2000});
  await page.addStyleTag({content:'#mobile-nav{display:none!important} #root{height:auto!important;overflow:visible!important}'});
  await page.locator('.personal-live-grid').screenshot({path:`/tmp/lock-league-live-results-shots/cards-${width}.png`});
  await page.evaluate(()=>document.documentElement.style.fontSize='20px');
  assert.equal(await page.evaluate(()=>document.getElementById('root').scrollWidth>document.getElementById('root').clientWidth+1),false,'large text overflow');
  assert.deepEqual(errors,[]);
  console.log(`${width}px: ${checks.length} state/render checks + color, overflow, enlarged text checks passed`);
  await page.close();
 }
}finally{await browser.close();}
