// Parse one visual leg at a time. Never use the next player's text to fill a
// missing market, direction or threshold. Incomplete legs remain editable.
function parlayMarket(text) {
 const t=String(text).toLowerCase().replace(/[_–—]/g,' ');
 if(/\b(first|last|longest|shortest|quarter|half|1st|2nd|3rd|4th)\b/.test(t))return 'manual';
 if(/^(?:game )?total points$/.test(t.trim()))return 'game_total';
 if(/any\s*time.*(?:touchdown|td)|touchdown scorer|to score (?:a |an? )?touchdown/.test(t))return 'anytime_td';
 if(/rush.*rec.*(?:yds|yards)/.test(t))return 'rush_rec_yds';
 if(/rush/.test(t))return /yds|yards/.test(t)?'rush_yds':/attempt|carr/.test(t)?'rush_att':/td|touchdown/.test(t)?'rush_tds':'manual';
 if(/receiv/.test(t))return /yds|yards/.test(t)?'rec_yds':/td|touchdown/.test(t)?'rec_tds':'receptions';
 if(/reception|\brec\b/.test(t))return /yds|yards/.test(t)?'rec_yds':/td|touchdown/.test(t)?'rec_tds':'receptions';
 if(/complet/.test(t))return 'pass_cmp';
 if(/intercept/.test(t))return 'pass_int';
 if(/pass/.test(t))return /yds|yards/.test(t)?'pass_yds':/attempt/.test(t)?'pass_att':/td|touchdown/.test(t)?'pass_tds':'manual';
 return 'manual';
}
function parlayCleanName(text) {
 return String(text).replace(/[©®™]+\s*$/g,'').replace(/^[^a-z]+/i,'').replace(/^[a-z]\s*[,;:]\s*(?=[a-z])/i,'').replace(/\s+/g,' ').trim().replace(/\s+[il1|]{3}$/i,' III');
}
function parlayNameKey(text) {return parlayCleanName(text).toLowerCase().replace(/[^a-z]/g,'');}
// A sportsbook repeats the player's name in the market subtitle. Match that
// repetition independently of punctuation, OCR suffixes and stray logo letters.
// Near matches are kept as one candidate but explicitly require name review.
function parlaySubtitleMatch(title,subtitle) {
 const core=s=>parlayCleanName(s).toLowerCase().replace(/[.'’]/g,'').replace(/[^a-z0-9 -]/g,' ').trim().replace(/\s+(?:jr|sr|[il1|]{1,4}|iv|v)$/, '').split(/\s+/).filter(Boolean);
 const a=core(title),b=core(subtitle);
 if(a.length<2||b.length<2)return {match:parlayNameKey(title)===parlayNameKey(subtitle),review:false};
 if(a.join('')===b.join(''))return {match:true,review:false};
 const trimLogo=(long,short)=>long.length===short.length+1&&long[0].length<=3&&long.slice(1).join('')===short.join('');
 if(trimLogo(a,b)||trimLogo(b,a))return {match:true,review:true};
 // Only one insertion/deletion/substitution in one substantial name token.
 // A long first-name OCR typo also requires review; short distinct names
 // such as Josh/Kyle are never matched by surname alone.
 const oneEdit=(x,y)=>{
  if(x===y)return true;
  if(Math.min(x.length,y.length)<5||Math.abs(x.length-y.length)>1)return false;
  let i=0,j=0,edits=0;
  while(i<x.length&&j<y.length){if(x[i]===y[j]){i++;j++;continue;}if(++edits>1)return false;if(x.length>=y.length)i++;if(y.length>=x.length)j++;}
  return edits+(x.length-i)+(y.length-j)<=1;
 };
 const sameFirst=a[0]===b[0];
 if(a.length===b.length&&sameFirst&&a.slice(1).filter((token,i)=>token!==b[i+1]).length===1&&a.slice(1).every((token,i)=>oneEdit(token,b[i+1])))return {match:true,review:true};
 if(a.length===b.length&&Math.max(a[0].length,b[0].length)>=7&&oneEdit(a[0],b[0])&&a.slice(1).every((token,i)=>token===b[i+1]))return {match:true,review:true};
 return {match:false,review:false};
}
function parseParlayDocument(text) {
 const lines=String(text).replace(/[\u2013\u2014]/g,'-').split(/\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
 const legs=[],warnings=[];let block=null;
 // Expanded sportsbook slips repeat a truncated summary before the matchup.
 // Read detailed legs below that anchor, not the summary or promotion header.
 const matchup=lines.findIndex(s=>/@/.test(s));
 const expanded=matchup>=0&&lines.slice(0,matchup).some(s=>/parlay/i.test(s));
 const legLines=expanded?lines.slice(matchup+1):lines;
 const header=expanded?lines.slice(0,matchup).join('\n'):lines.filter(s=>/parlay|odds/i.test(s)).join('\n');
 const prices=[...header.matchAll(/[+]\s*(\d{3,6})\b/g)].map(m=>Number(m[1]));
 // Profit boosts show old and new odds left-to-right; do not infer a boost
 // from its percentage. Leave ambiguous odds for manual review.
 const boosted=/boost/i.test(header);
 const odds=prices.length===1&&!boosted?prices[0]:prices.length===2&&boosted&&prices[1]>prices[0]?prices[1]:null;
 if((prices.length>1||boosted)&&odds==null)warnings.push('Check the combined odds against the slip.');
 const hasMarket=s=>/\b(?:yds|yards|receptions?|rec|touchdowns?|tds?|passing|rushing|receiving|completions?|attempts?|interceptions?|carries|total points)\b/i.test(s);
 const meta=s=>/\b(?:parlay|wager|payout|stake|balance|betslip|bet slip|potential|boost|cash out|total odds|placed|receipt|bet id|bet amount|to win|same game|not settled|monday night football|thursday night football|selection|fanduel|draftkings)\b|@|\bvs\.?\b|\b(?:AM|PM)\s*(?:CT|CDT|CST|ET|EDT|EST)?\b|^[+\-]\d{3,}$|^\$|^\d+\s+legs?\b/i.test(s);
 const sameName=(a,b)=>parlayNameKey(a)===parlayNameKey(b);
 function finish() {
  if(!block)return;
  let {player,side,line,markets,raw,issues}=block;
  const known=[...new Set(markets.filter(m=>m!=='manual'))];
  let market=known.length===1&&!markets.includes('manual')?known[0]:'';
  if(known.length>1)issues.push('Conflicting markets were read. Choose the correct one.');
  if(!market)issues.push('Market was not read clearly.');
  if(market==='anytime_td'){side='yes';line=null;}
  else {if(!side)issues.push('Direction was not read clearly.');if(line==null)issues.push('Threshold was not read clearly.');}
  if(market==='game_total')player='Game total';
  if(!player)issues.push('Player was not read clearly.');
  // Preserve unsupported markets as unresolved fields, not fabricated Custom bets.
  legs.push({player:player||'',market,side:side||'',line:line??null,member_id:null,result:null,source_text:raw.join('\n'),review:[...new Set(issues)]});
  block=null;
 }
 function start(player='') {block={player,side:null,line:null,markets:[],marketTexts:[],raw:[],issues:[]};}
 function name(player,selection=false) {
  player=parlayCleanName(player);
  if(!block)start(player);
  else if(!block.player)block.player=player;
  else if(!sameName(block.player,player)||selection&&block.side){finish();start(player);}
 }
 function subtitle(player) {
  if(block?.player){
   const paired=parlaySubtitleMatch(block.player,player);
   if(paired.match){
    if(paired.review)block.issues.push('The repeated player name differs slightly. Check the name against the screenshot.');
    return;
   }
  }
  name(player);
 }
 function addMarket(s) {
  if(!hasMarket(s))return;
  block.marketTexts.push(s);const key=parlayMarket(s);
  if(key!=='manual')block.markets.push(key);
  else if(!/^(?:total |alt )?(?:passing|rushing|receiving|yards?|yds|tds?|touchdowns?)$/i.test(s.trim()))block.markets.push('manual');
  const joined=parlayMarket(block.marketTexts.join(' '));if(joined!=='manual')block.markets.push(joined);
 }
 function setSelection(side,line) {
  if(!block)start();
  if(block.side&&block.side!==side)block.issues.push('Conflicting directions were read.');
  if(block.line!=null&&line!=null&&block.line!==line){block.issues.push('Conflicting thresholds were read.');block.line=null;}
  else if(line!=null)block.line=line;
  block.side=side;
 }
 for(const [index,s] of legLines.entries()) {
  if(/total charged|total payout|cash out/i.test(s))break;
  if(meta(s)||/^(?:open|settled|saved|home|my bets|live now|all sports|rewards|bet protect[+]?)(?:\s|$)/i.test(s))continue;
  // Name + selection, or a selection wrapped onto the line beneath its name.
  const ou=s.match(/^(.*?)(over|under)\s*\+?\s*(\d+(?:[.,]\d+)?)(.*)$/i)||s.match(/^(.*?)\b(over|under|at least)\b\s*\+?\s*(\d+(?:[.,]\d+)?)?(.*)$/i);
  const alt=s.match(/^(.*?)\b(\d+(?:[.,]\d+)?)\s*\+\s*(.*)$/);
  if(ou||alt) {
   const m=ou||alt,player=parlayCleanName(m[1]);
   if(player)name(player,true);else if(block&&(block.side&&block.line!=null||block.markets.includes('anytime_td'))){finish();start();}else if(!block)start();
   block.raw.push(s);
   setSelection(ou?ou[2].toLowerCase().replace('at least','atleast'):'atleast',ou?(ou[3]?Number(ou[3].replace(',','.')):null):Number(alt[2].replace(',','.')));
   const tail=ou?ou[4]:alt[3];
   if(/^\s*[.,]?\s*\d/.test(tail)||alt&&/\d/.test(alt[1])&&!/[a-z]/i.test(alt[1])){block.line=null;block.issues.push('The number may be split or misread. Enter the threshold from the screenshot.');}
   addMarket(tail);continue;
  }
  // Repeated full name in the sportsbook's market subtitle is an anchor, not
  // another pick. It also protects adjacent players from bleeding together.
  const descriptor=s.match(/^(.+?)\s*[-:|]\s*((?:total|alt|first|last|longest|shortest|passing|pass|rushing|rush|receiving|receptions|rec|completions|interceptions|any\s*time).*?)$/i);
  if(descriptor&&hasMarket(descriptor[2])) {
   subtitle(descriptor[1]);block.raw.push(s);addMarket(descriptor[2]);continue;
  }
  if(hasMarket(s)) {
   const anytime=s.match(/^(.+?)\s+(?:any\s*time\s+(?:touchdown|td)|to score (?:a )?touchdown)/i);
   const heading=s.match(/^(.+?)\s+(?=(?:total|alt|first|last|longest|shortest|passing|rushing|receiving|receptions|completions|interceptions)\b)/i);
   if(anytime)name(anytime[1],true);else if(heading&&heading[1].trim().split(/\s+/).length>=2)subtitle(heading[1]);else if(!block)start();
   block.raw.push(s);addMarket(s);continue;
  }
  if(/^(?:total|alt(?:ernate)?|player)$/i.test(s)){if(block)block.raw.push(s);continue;}
  if(/^\+?\d+(?:[.,]\d+)?$/.test(s)) {
   if(block?.side&&block.line==null){block.raw.push(s);block.line=Number(s.replace(',','.'));}
   continue;
  }
  // A standalone player heading is kept even if OCR missed their selection.
  if(/^[a-z][a-z .'-]*(?:\s+[a-z][a-z .'-]*)+$/i.test(parlayCleanName(s))) {
   const next=legLines[index+1]||'',nextMarket=hasMarket(next)?parlayMarket(next):null;
   const known=block?.markets.filter(m=>m!=='manual')||[];
   const newSelection=/^(?:over|under)\s*\+?\s*\d|^\d+(?:\.\d+)?\s*\+/i.test(next);
   if(block?.side&&(newSelection||nextMarket==='anytime_td'&&block.side!=='yes'||known.length&&nextMarket&&nextMarket!=='manual'&&!known.includes(nextMarket))){finish();start(parlayCleanName(s));}
   else if(block?.side&&nextMarket)subtitle(s);
   else name(s);
   block.raw.push(s);
  } else if(block) {block.raw.push(s);block.issues.push('Some text could not be read. Check the screenshot.');}
 }
 finish();
 const declared=String(text).match(/\b(\d{1,2})\s*[- ]?\s*leg(?:s)?\b/i)?.[1];
 if(declared&&Number(declared)!==legs.length)warnings.push(`The slip says ${declared} legs, but ${legs.length} were found. Check for missing or extra legs.`);
 if(legs.some(l=>l.review.length))warnings.push('Some legs need correction. Uncertain fields have been left blank.');
 if(legs.length>25)warnings.push('More than 25 candidates were found. Remove non-pick text before saving.');
 return {legs,text:String(text),warnings,odds,odds_review:(prices.length>1||boosted)&&odds==null};
}
function parseParlayText(text) {return parseParlayDocument(text).legs;}
