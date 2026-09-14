// Group parlays are independent of league picks, standings and payouts.
const PARLAY_MARKETS={pass_yds:'Passing yards',pass_tds:'Passing TDs',pass_cmp:'Completions',pass_att:'Pass attempts',pass_int:'Interceptions',rush_yds:'Rushing yards',rush_att:'Rush attempts',rush_tds:'Rushing TDs',rec_yds:'Receiving yards',receptions:'Receptions',rec_tds:'Receiving TDs',rush_rec_yds:'Rush + rec yards',anytime_td:'Anytime touchdown',manual:'Custom / manual result'};
const parlayState={data:null,draft:null,busy:false,error:'',week:null,season:null,night:'All',timer:null};
function parlayMarket(text) {
 const t=text.toLowerCase();
 if(/first|last|longest|quarter|half/.test(t))return 'manual';
 if(/any\s*time.*touchdown|any\s*time.*td/.test(t))return 'anytime_td';
 if(/rush.*rec.*(?:yds|yards)/.test(t))return 'rush_rec_yds';
 if(/rush/.test(t))return /yds|yards/.test(t)?'rush_yds':/attempt|carr/.test(t)?'rush_att':/td|touchdown/.test(t)?'rush_tds':'manual';
 if(/receiv/.test(t))return /yds|yards/.test(t)?'rec_yds':/td|touchdown/.test(t)?'rec_tds':'receptions';
 if(/reception/.test(t))return 'receptions';
 if(/complet/.test(t))return 'pass_cmp';
 if(/intercept/.test(t))return 'pass_int';
 if(/pass/.test(t))return /yds|yards/.test(t)?'pass_yds':/attempt/.test(t)?'pass_att':/td|touchdown/.test(t)?'pass_tds':'manual';
 return 'manual';
}
function parseParlayText(text) {
 const lines=String(text).split(/\n/).map(s=>s.trim()).filter(Boolean),legs=[];
 for(let i=0;i<lines.length;i++) {
  const s=lines[i],ou=s.match(/^(.+?)\s+(Over|Under)\s*\+?(\d+(?:\.\d+)?)/i),alt=s.match(/^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+)$/i);
  if(ou||alt) {
   const next=lines[i+1]||'',market=parlayMarket(s+' '+next);
   legs.push({player:(market==='manual'?s+' '+next:(ou||alt)[1]).replace(/^[^a-z]+/i,'').trim().replace(/\s+[il]{3}$/i,' III').slice(0,150),market,side:ou?ou[2].toLowerCase():'atleast',line:Number(ou?ou[3]:alt[2]),member_id:null,result:null});
  } else if(/any\s*time\s+(?:touchdown|td)/i.test(s)) {
   const player=s.replace(/any\s*time\s+(?:touchdown|td).*$/i,'').trim()||lines[i-1]||'';
   if(player)legs.push({player:player.replace(/^[^a-z]+/i,'').trim().replace(/\s+[il]{3}$/i,' III'),market:'anytime_td',side:'yes',line:null,member_id:null,result:null});
  }
 }
 return legs.slice(0,25);
}
function parlayRecord(slips,members,night='All') {
 return members.map(m=>{
  const legs=slips.filter(s=>night==='All'||s.night===night).flatMap(s=>s.legs).filter(l=>l.member_id===m.id);
  const W=legs.filter(l=>l.result==='W').length,L=legs.filter(l=>l.result==='L').length,P=legs.filter(l=>l.result==='P').length,V=legs.filter(l=>l.result==='V').length;
  return {...m,W,L,P,V,open:legs.filter(l=>!l.result).length,pct:W+L?W/(W+L):null};
 }).sort((a,b)=>(b.pct??-1)-(a.pct??-1)||b.W-a.W||a.name.localeCompare(b.name));
}
function parlayLegLabel(l) {return l.market==='manual'?l.player:`${l.player} · ${l.market==='anytime_td'?'Anytime TD':`${l.side==='atleast'?`${l.line}+`:l.side+' '+l.line} ${PARLAY_MARKETS[l.market]||l.market}`}`;}
function parlayOptions(options,value) {return Object.entries(options).map(([k,v])=>`<option value="${escapeHtml(k)}" ${String(value)===k?'selected':''}>${escapeHtml(v)}</option>`).join('');}
async function parlayFetch(url,body) {
 const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Unable to load parlays.');return data;
}
async function loadParlays() {
 if(parlayState.busy)return;
 parlayState.busy=true;
 try {
  const season=parlayState.season||currentNflWeekClient().season||2026,week=parlayState.week||currentNflWeekClient().week||1;
  parlayState.data=await parlayFetch(`/api/parlays?season=${season}&week=${week}`);parlayState.error='';
  parlayState.season=season;parlayState.week=week;
 }catch(e){parlayState.error=e.message;}finally{parlayState.busy=false;}
}
function renderParlays() {
 if(!state.user)return '<div class="compact-panel"><h1>Parlays</h1><p>Sign in to track the group’s Monday and Thursday slips.</p><button data-account class="text-action">Sign in →</button></div>';
 const d=parlayState.data;
 const err=parlayState.error?`<p class="parlay-error" role="alert">${escapeHtml(parlayState.error)}</p>`:'';
 if(!d)return `${err}<p role="status">Loading parlays…</p><button id="parlay-refresh" class="text-action">Retry</button>`;
 if(parlayState.draft)return renderParlayEditor()+err;
 const visible=d.slips.filter(s=>s.week===parlayState.week&&(parlayState.night==='All'||s.night===parlayState.night));
 const leaderboard=parlayRecord(d.slips,d.members,parlayState.night);
 return `<section class="parlays"><div class="parlay-heading"><div><h1>GROUP PARLAYS</h1><p class="quiet-copy">Monday & Thursday · Every leg counts</p></div><button id="parlay-new" class="parlay-primary">Upload slip</button></div>${err}
 <div class="parlay-filters"><label>Season<input id="parlay-season" type="number" min="2026" max="2100" value="${parlayState.season}"></label><label>Week<select id="parlay-week">${parlayOptions(Object.fromEntries(Array.from({length:18},(_,i)=>[i+1,`Week ${i+1}`])),parlayState.week)}</select></label><label>Night<select id="parlay-night">${parlayOptions({All:'Both nights',Monday:'Monday',Thursday:'Thursday'},parlayState.night)}</select></label><button id="parlay-refresh" class="text-action">Refresh</button></div>
 <div class="parlay-layout"><div>${visible.length?visible.map(renderParlaySlip).join(''):'<div class="compact-panel"><h2>No slip yet</h2><p class="quiet-copy">Upload the screenshot, review the legs, then assign each pick to its member.</p></div>'}</div>
 <aside class="compact-panel parlay-leaders"><h2>LEG LEADERBOARD</h2><p class="quiet-copy">Season ${parlayState.season} · ${parlayState.night==='All'?'Both nights':parlayState.night}</p><div class="parlay-rank-head"><span>Member</span><span>Hit–Miss</span><span>Hit rate</span></div>${leaderboard.map(m=>`<div class="parlay-rank"><span>${escapeHtml(m.name)}<small>${m.W+m.L} settled${m.open?` · ${m.open} open`:''}${m.P?` · ${m.P} push`:''}${m.V?` · ${m.V} void`:''}</small></span><b>${m.W}–${m.L}</b><b>${m.pct==null?'—':(m.pct*100).toFixed(0)+'%'}</b></div>`).join('')}<p class="quiet-copy">Hit rate excludes pushes and voids. Separate from league standings.</p></aside></div></section>`;
}
function renderParlaySlip(s) {
 const d=parlayState.data,g=d.games[s.game_key],open=s.legs.filter(l=>!l.result).length,hit=s.legs.filter(l=>l.result==='W').length;
 const status=s.legs.some(l=>l.result==='L')?'Missed':open?'Open':hit?'Hit':'Voided / pushed';
 const editable=d.me.admin||s.created_by===d.me.id;
 const score=g&&g.state!=='pre'?`${g.away_score??'–'}–${g.home_score??'–'} · ${g.detail||g.state}`:g?.kickoff?new Date(g.kickoff).toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'numeric',minute:'2-digit'})+' CT':'Awaiting game data';
 return `<article class="parlay-slip compact-panel"><div class="parlay-heading"><div><p class="quiet-copy">${escapeHtml(s.night)} · Week ${s.week}${s.odds!=null?' · '+americanOdds(s.odds):''}</p><h2>${escapeHtml(s.title)}</h2></div><span class="parlay-status ${status==='Hit'?'hit':status==='Missed'?'miss':''}">${status}</span></div><p class="quiet-copy">${escapeHtml(s.game_key.replace('@',' @ '))}<br>${escapeHtml(score)}</p>${g?.state==='in'&&!g.stats_available?'<p class="quiet-copy">Live player stats are temporarily unavailable.</p>':''}<p>${hit}/${s.legs.length} legs hit${open?` · ${open} open`:''}</p>
 ${s.legs.map((saved,i)=>{
 const live=g?.progress?.[s.id]?.[i],l={...saved,actual:live&&['player','market','side','line'].every(k=>live[k]===saved[k])?live.actual:saved.actual},member=d.members.find(m=>m.id===l.member_id);
 const photo=l.market!=='manual'?slPlayerPhoto(l.player):null;
 const label={W:'HIT',L:'MISS',P:'PUSH',V:'VOID'}[l.result]|| (g?.state==='in'?'LIVE':g?.state==='post'?'NEEDS RESULT':'PENDING');
 const target=l.side==='yes'?1:l.line,progress=l.actual!=null&&target>0?Math.max(0,Math.min(100,l.actual/target*100)):null;
 return `<div class="parlay-leg"><div class="parlay-leg-top">${photo?`<img src="${escapeHtml(photo)}" alt="" width="44" height="48" onerror="this.hidden=true">`:''}<div><small>${escapeHtml(member?.name||'Unassigned')}</small><strong>${escapeHtml(parlayLegLabel(l))}</strong></div><span class="parlay-status ${l.result==='W'?'hit':l.result==='L'?'miss':''}">${label}</span></div>${l.actual!=null?`<div class="parlay-progress" role="progressbar" aria-label="${escapeHtml(l.player)} progress" aria-valuemin="0" aria-valuemax="${target||1}" aria-valuenow="${Math.max(0,Math.min(target||1,l.actual))}"><span style="width:${progress??0}%"></span></div><small class="quiet-copy">${l.actual} ${escapeHtml(PARLAY_MARKETS[l.market]||'')} · Target ${target??'—'}${l.side==='under'?' (under)':''}</small>`:''}${editable?`<details><summary>Correct result</summary><label>Result<select data-parlay-grade="${s.id}" data-leg="${i}" data-version="${s.version}">${parlayOptions({'':'Automatic / pending',W:'Hit',L:'Miss',P:'Push',V:'Void'},l.manual?l.result:'')}</select></label></details>`:''}</div>`;
 }).join('')}<div class="parlay-actions">${s.has_image?`<a class="text-action" href="/api/parlays?image=${s.id}" target="_blank" rel="noopener">View original slip ↗</a>`:''}${editable?`<button class="text-action" data-parlay-edit="${s.id}">Edit / assign legs</button>`:''}</div></article>`;
}
function renderParlayEditor() {
 const s=parlayState.draft,d=parlayState.data;
 return `<section class="parlays"><div class="parlay-heading"><h1>${s.version?'EDIT SLIP':'ADD A PARLAY'}</h1><button id="parlay-cancel" class="text-action">Cancel</button></div><p class="quiet-copy">Upload a screenshot, check every leg, and choose who picked it. Nothing is saved until you confirm.</p>
 <form id="parlay-form"><div class="compact-panel"><label>Slip screenshot<input id="parlay-image" type="file" accept="image/*"></label><p id="parlay-ocr-status" role="status">${s.image?'Screenshot ready. Review the legs below.':'Choose a screenshot to read its legs, or add legs manually.'}</p>${s.image?`<details><summary>Preview slip</summary><img class="parlay-preview" src="${s.image}" alt="Uploaded parlay slip"></details>`:''}
 <div class="parlay-fields"><label>Title<input name="title" maxlength="100" required value="${escapeHtml(s.title)}"></label><label>Night<select name="night">${parlayOptions({Monday:'Monday',Thursday:'Thursday'},s.night)}</select></label><label>Week<input name="week" type="number" min="1" max="18" required value="${s.week}"></label><label>Season<input name="season" type="number" min="2026" max="2100" required value="${s.season}"></label><label>Game<select name="game_key" required><option value="">Choose game</option>${parlayOptions(Object.fromEntries([...new Set([...(d.schedule||[]).map(g=>g.key),...(s.game_key?[s.game_key]:[])])].map(k=>[k,k.replace('@',' @ ')])),s.game_key)}</select></label><label>Combined odds (optional)<input name="odds" type="number" placeholder="+10087" value="${s.odds??''}"></label></div><p class="quiet-copy">Choose a different week on the tracker before adding a slip for another slate.</p></div>
 <div id="parlay-edit-legs">${s.legs.map((l,i)=>`<fieldset class="compact-panel parlay-edit-leg" data-leg-index="${i}"><legend>Leg ${i+1}</legend><div class="parlay-fields"><label>Player / custom pick<input data-field="player" maxlength="150" required value="${escapeHtml(l.player)}"></label><label>Market<select data-field="market">${parlayOptions(PARLAY_MARKETS,l.market)}</select></label><label>Direction<select data-field="side">${parlayOptions({over:'Over',under:'Under',atleast:'At least (N+)',yes:'Yes — anytime TD'},l.side)}</select></label><label>Threshold<input data-field="line" type="number" step="0.5" min="0" max="2000" ${['anytime_td','manual'].includes(l.market)?'disabled':''} value="${l.line??''}"></label><label>Picked by<select data-field="member_id">${parlayOptions({'':'Unassigned',...Object.fromEntries(d.members.map(m=>[m.id,m.name]))},l.member_id??'')}</select></label></div><button type="button" class="text-action" data-parlay-remove="${i}">Remove leg</button></fieldset>`).join('')}</div>
 <div class="parlay-actions"><button type="button" id="parlay-add" class="text-action">+ Add leg</button><button type="submit" class="parlay-primary">${s.version?'Save changes':'Save parlay'}</button></div></form></section>`;
}
function readParlayDraft() {
 const form=document.getElementById('parlay-form');if(!form)return;
 const s=parlayState.draft;
 for(const key of ['title','night','game_key'])s[key]=form.elements[key].value;
 for(const key of ['week','season'])s[key]=Number(form.elements[key].value);
 s.odds=form.elements.odds.value===''?null:Number(form.elements.odds.value);
 s.legs=[...form.querySelectorAll('[data-leg-index]')].map(el=>{
 const v=k=>el.querySelector(`[data-field="${k}"]`).value;
 return {player:v('player'),market:v('market'),side:v('side'),line:v('line')===''?null:Number(v('line')),member_id:v('member_id')===''?null:Number(v('member_id'))};
 });
}
function paintParlays() {if(state.view!=='parlays')return;document.getElementById('root').innerHTML=renderParlays();bindParlays();}
async function refreshParlayView() {await loadParlays();if(!parlayState.draft)paintParlays();}
async function enterParlays() {
 paintParlays();if(!state.user)return;await loadParlays();if(state.view!=='parlays')return;paintParlays();
 loadSlPlayerPhotos().then(()=>{if(!parlayState.draft)paintParlays();});
 clearInterval(parlayState.timer);parlayState.timer=setInterval(()=>{if(state.view!=='parlays'){clearInterval(parlayState.timer);return;}if(!document.hidden&&!parlayState.draft)refreshParlayView();},15000);
}
async function readParlayImage(file,draft) {
 if(file.size>15000000)throw Error('Choose a screenshot smaller than 15 MB.');
 const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');
 const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
 const image=canvas.toDataURL('image/jpeg',.85);if(image.length>1500000)throw Error('This screenshot is too large. Crop to the slip and try again.');
 draft.image=image;
 if(!window.Tesseract)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';const timeout=setTimeout(()=>reject(Error('Image reading timed out. Enter legs manually or retry.')),20000);script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(Error('Image reading is unavailable. You can still enter the legs below.'));};document.head.appendChild(script);});
 let initTimer,expired=false;
 const creation=Tesseract.createWorker('eng',1,{logger:m=>{const el=document.getElementById('parlay-ocr-status');if(el)el.textContent=`Reading screenshot… ${Math.round((m.progress||0)*100)}%`;}});
 creation.then(w=>{if(expired)w.terminate();},()=>{});
 let worker;try{worker=await Promise.race([creation,new Promise((_,reject)=>{initTimer=setTimeout(()=>{expired=true;reject(Error('Image reader could not load. Retry or enter the legs manually.'));},45000);})]);}finally{clearTimeout(initTimer);}
 let timeout;try {const {data}=await Promise.race([worker.recognize(image),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Reading took too long. Enter the legs manually or retry.')),90000);})]);return {legs:parseParlayText(data.text),text:data.text};}finally{clearTimeout(timeout);await worker.terminate();}
}
function bindParlays() {
 const byId=id=>document.getElementById(id);
 if(byId('parlay-refresh'))byId('parlay-refresh').onclick=refreshParlayView;
 for(const [id,key] of [['parlay-week','week'],['parlay-season','season']])if(byId(id))byId(id).onchange=e=>{parlayState[key]=Number(e.target.value);refreshParlayView();};
 if(byId('parlay-night'))byId('parlay-night').onchange=e=>{parlayState.night=e.target.value;paintParlays();};
 if(byId('parlay-new'))byId('parlay-new').onclick=()=>{parlayState.draft={id:crypto.randomUUID(),season:parlayState.season,week:parlayState.week,night:'Monday',title:'Monday night parlay',game_key:'',odds:null,legs:[]};paintParlays();};
 document.querySelectorAll('[data-parlay-edit]').forEach(b=>b.onclick=()=>{parlayState.draft=structuredClone(parlayState.data.slips.find(s=>s.id===b.dataset.parlayEdit));paintParlays();});
 if(byId('parlay-cancel'))byId('parlay-cancel').onclick=()=>{if(confirm('Discard unsaved changes to this slip?')){parlayState.draft=null;parlayState.error='';paintParlays();}};
 if(byId('parlay-add'))byId('parlay-add').onclick=()=>{readParlayDraft();if(parlayState.draft.legs.length>=25)return;parlayState.draft.legs.push({player:'',market:'receptions',side:'over',line:null,member_id:null});paintParlays();};
 document.querySelectorAll('[data-parlay-remove]').forEach(b=>b.onclick=()=>{readParlayDraft();parlayState.draft.legs.splice(Number(b.dataset.parlayRemove),1);paintParlays();});
 document.querySelectorAll('[data-field="market"]').forEach(el=>el.onchange=()=>{readParlayDraft();const l=parlayState.draft.legs[Number(el.closest('[data-leg-index]').dataset.legIndex)];if(l.market==='anytime_td'){l.side='yes';l.line=null;}else if(l.side==='yes')l.side='over';paintParlays();});
 if(byId('parlay-image'))byId('parlay-image').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;readParlayDraft();
  if(parlayState.draft.legs.length&&!confirm('Read this screenshot and replace the draft legs?'))return;
  const draft=parlayState.draft;
  const form=byId('parlay-form');for(const el of form.elements)el.disabled=true;
  try {const parsed=await readParlayImage(file,draft);if(parlayState.draft!==draft)return;if(parsed.legs.length)draft.legs=parsed.legs;parlayState.error=parsed.legs.length?'':'No legs were read confidently. Add them manually using the screenshot preview.';}catch(err){parlayState.error=err.message;}finally{paintParlays();}
 };
 if(byId('parlay-form'))byId('parlay-form').onsubmit=async e=>{
  e.preventDefault();readParlayDraft();const draft=parlayState.draft;
  if(!draft.legs.length){parlayState.error='Add at least one leg.';paintParlays();return;}
  if(!confirm(`Save ${draft.legs.length} reviewed legs for ${draft.title}?`))return;
  const button=e.submitter;if(button)button.disabled=true;
  try{await parlayFetch('/api/parlays?action=save',draft);parlayState.draft=null;parlayState.error='';await refreshParlayView();}catch(err){parlayState.error=err.message;paintParlays();}
 };
 document.querySelectorAll('[data-parlay-grade]').forEach(el=>el.onchange=async()=>{
  if(!confirm('Confirm this result correction? It changes the member’s parlay record.')){paintParlays();return;}
  el.disabled=true;try{await parlayFetch('/api/parlays?action=grade',{id:el.dataset.parlayGrade,index:Number(el.dataset.leg),version:Number(el.dataset.version),result:el.value||null});await refreshParlayView();}catch(err){parlayState.error=err.message;paintParlays();}
 });
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.view==='parlays'&&!parlayState.draft)refreshParlayView();});
