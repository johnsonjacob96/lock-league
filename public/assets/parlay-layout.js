// Spatial document reader. Each market is paired with nearby, aligned text;
// unrelated UI and another selection's text cannot complete a missing field.
function parlayLayoutText(text) {
 return String(text).replace(/[–—−]/g,'-').replace(/[©®™]/g,'').replace(/\s+/g,' ').trim();
}
function parlayLayoutName(text) {
 return parlayCleanName(parlayLayoutText(text)).replace(/\s+[il1|]{3}$/i,' III').replace(/\s*[-:|]\s*$/,'').trim();
}
function parlayLayoutLine(line) {
 let words=(line.words||[]).filter(w=>w.text?.trim());
 const letters=words.filter(w=>/[a-z]{2}/i.test(w.text));
 if(letters.length>=2) {
  const heights=letters.map(w=>w.bbox.y1-w.bbox.y0).sort((a,b)=>a-b),h=heights[Math.floor(heights.length/2)];
  const bottoms=letters.map(w=>w.bbox.y1).sort((a,b)=>a-b),baseline=bottoms[Math.floor(bottoms.length/2)];
  words=words.filter(w=>{
   const height=w.bbox.y1-w.bbox.y0;
   return Math.abs(w.bbox.y1-baseline)<h*.55&&height<h*1.6&&(height>h*.4||/^[-:|]$/.test(w.text));
  });
 }
 while(words.length&&/^[^a-z0-9+\-]+$/i.test(parlayLayoutText(words[0].text)))words.shift();
 while(words.length&&!parlayLayoutText(words.at(-1).text))words.pop();
 if(!words.length)return null;
 const bbox={x0:Math.min(...words.map(w=>w.bbox.x0)),y0:Math.min(...words.map(w=>w.bbox.y0)),x1:Math.max(...words.map(w=>w.bbox.x1)),y1:Math.max(...words.map(w=>w.bbox.y1))};
 return {text:parlayLayoutText(words.map(w=>w.text).join(' ')),words,bbox,height:bbox.y1-bbox.y0,confidence:words.reduce((n,w)=>n+w.confidence,0)/words.length};
}
function parlayLayoutMeta(text) {
 return /\b(parlay|wager|payout|stake|balance|boost|cash out|cashed out|total charged|to pay|rewards|pending|bet protect|bet slip|betslip)\b|@|\bvs\.?\b|\b(?:AM|PM)\s*(?:CT|ET)?\b/i.test(text);
}
function parlayLayoutSummary(text) {
 return /,|\.\.\./.test(text)||([...text.matchAll(/\b(?:over|under)\s*[+\-]?\d|\d\s*\+/gi)].length>1);
}
function parlayLayoutMarket(text) {
 const s=parlayLayoutText(text);
 if(/^(?:game )?total(?: points)?$/i.test(s))return 'game_total';
 if(/^(?:point )?spread$/i.test(s))return 'spread';
 return parlayMarket(s);
}
function parlayLayoutSelection(text) {
 const s=parlayLayoutText(text);
 const ou=s.match(/^(.*?)\b(over|under|at least)\s*\+?\s*(\d+(?:\.\d+)?)\b/i);
 const alt=s.match(/^(.*?)\b(\d+(?:\.\d+)?)\s*\+/);
 const spread=s.match(/^(.+?)\s*([+\-]\d+(?:\.\d+)?)$/);
 if(ou)return {player:parlayLayoutName(ou[1]),side:ou[2].toLowerCase().replace('at least','atleast'),line:/^\s*[.,]?\s*\d/.test(s.slice(ou[0].length))?null:Number(ou[3])};
 if(alt)return {player:parlayLayoutName(alt[1]),side:'atleast',line:Number(alt[2])};
 if(spread)return {player:parlayLayoutName(spread[1]),side:'spread',line:Number(spread[2])};
 return null;
}
function parlayLayoutDescriptor(text) {
 if(parlayLayoutMeta(text)||parlayLayoutSummary(text))return null;
 const market=parlayLayoutMarket(text);
 const marker=/\b(?:any\s*time|first|last|longest|shortest|quarter|half|total|alt(?:ernate)?|passing|rushing|receiving|receptions?|completions?|interceptions?|spread|moneyline)\b/i;
 const found=marker.exec(text);
 if(!found)return null;
 const prefix=text.slice(0,found.index).replace(/\s*[-:|]\s*$/,'').trim();
 const selection=parlayLayoutSelection(text);
 return {market:market==='manual'?'':market,player:selection?selection.player:parlayLayoutName(prefix),inline:!!selection};
}
function parlayLayoutPass(rawLines,pass) {
 const lines=rawLines.map(parlayLayoutLine).filter(Boolean).sort((a,b)=>a.bbox.y0-b.bbox.y0||a.bbox.x0-b.bbox.x0);
 const descriptors=lines.map(line=>({line,desc:parlayLayoutDescriptor(line.text)})).filter(x=>x.desc);
 const used=new Set(),candidates=[];
 const aligned=(a,b)=>Math.abs(a.bbox.x0-b.bbox.x0)<Math.max(a.height,b.height)*1.6;
 function make(anchor,desc,title,following=null) {
  const source=[title,anchor,following].filter(Boolean).sort((a,b)=>a.bbox.y0-b.bbox.y0);source.forEach(l=>used.add(l));
  const selection=parlayLayoutSelection((following||title||anchor).text);
  let player=selection?.player||desc.player||parlayLayoutName(title?.text||'');
  const review=[];
  if(desc.player&&selection?.player){const pairing=parlaySubtitleMatch(desc.player,selection.player);if(!pairing.match||pairing.review)review.push('The name and market subtitle disagree. Check this selection.');}
  const market=desc.market,side=market==='anytime_td'?'yes':selection?.side||'',value=market==='anytime_td'?null:selection?.line??null;
  if(market==='game_total')player='Game total';
  if(!player)review.push('Subject was not read clearly.');
  if(!market)review.push('Market needs review.');
  if(market!=='anytime_td'&&(!side||value==null))review.push('Selection was not read clearly.');
  if(market==='spread'&&side!=='spread'||market==='game_total'&&!['over','under'].includes(side))review.push('Direction does not match the market.');
  // Word confidence excludes neighboring jersey art and a low-confidence logo
  // cannot erase an otherwise clearly read number.
  const numeric=(following||title||anchor).words.filter(w=>/\d/.test(w.text));
  const numericConfidence=numeric.length?Math.min(...numeric.map(w=>w.confidence)):100;
  const bbox={x0:Math.min(...source.map(l=>l.bbox.x0)),y0:Math.min(...source.map(l=>l.bbox.y0)),x1:Math.max(...source.map(l=>l.bbox.x1)),y1:Math.max(...source.map(l=>l.bbox.y1))};
  candidates.push({player,market,side,line:value,member_id:null,result:null,source_text:source.map(l=>l.text).join('\n'),source_box:bbox,review,pass,confidence:Math.min(...source.map(l=>l.confidence)),numericConfidence,anchor:{...anchor.bbox}});
 }
 // Market subtitles are stronger grouping anchors than selection titles.
 for(const {line:anchor,desc} of descriptors.filter(x=>!x.desc.inline)) {
  const options=lines.filter(l=>l!==anchor&&!used.has(l)&&!parlayLayoutMeta(l.text)&&!parlayLayoutSummary(l.text)&&l.bbox.y1<=anchor.bbox.y0+anchor.height*.2&&anchor.bbox.y0-l.bbox.y1<anchor.height*3.5);
  // Clip only graphic words left of an aligned subtitle, after spatial detection.
  const titles=options.map(l=>{
   const words=l.words.filter(w=>w.bbox.x1>=anchor.bbox.x0-anchor.height*.6);
   return {original:l,line:words.length?parlayLayoutLine({...l,words}):null};
  }).filter(x=>x.line&&aligned(x.line,anchor)&&!descriptors.some(d=>d.line===x.original&&!d.desc.inline));
  titles.sort((a,b)=>b.line.bbox.y1-a.line.bbox.y1);
  const title=titles[0];
  if(title)used.add(title.original);
  let following=null;
  if(desc.market!=='anytime_td'&&!parlayLayoutSelection(title?.line.text||'')) {
   const subject=desc.player||parlayLayoutName(title?.line.text||'');
   following=lines.find(l=>{const selected=parlayLayoutSelection(l.text);return !used.has(l)&&l.bbox.y0>=anchor.bbox.y1&&l.bbox.y0-anchor.bbox.y1<anchor.height*3.5&&aligned(l,anchor)&&selected&&(!selected.player||parlayNameKey(selected.player)===parlayNameKey(subject))&&!parlayLayoutMeta(l.text)&&!parlayLayoutSummary(l.text);});
  }
  make(anchor,desc,title?.line,following);
 }
 for(const {line,desc} of descriptors.filter(x=>x.desc.inline))if(!used.has(line))make(line,desc,null);
 // Preserve selection rows with missing market labels inside/beside the detail
 // region rather than inventing their market or silently discarding them.
 if(candidates.length) {
  const first=Math.min(...candidates.map(c=>c.source_box.y0)),last=Math.max(...candidates.map(c=>c.source_box.y1));
  for(const line of lines)if(!used.has(line)&&!parlayLayoutMeta(line.text)&&!parlayLayoutSummary(line.text)&&parlayLayoutSelection(line.text)&&line.bbox.y0>=first&&line.bbox.y0<last+line.height*5)make(line,{market:'',player:'',inline:true},null);
 }
 return candidates;
}
function parseParlayLayout(passes,width,height) {
 const candidates=passes.flatMap((p,i)=>p.mode==='binary'?[]:parlayLayoutPass(p.lines,i)),groups=[];
 for(const candidate of candidates) {
  const box=candidate.anchor,h=box.y1-box.y0;
  const group=groups.find(g=>Math.abs(g[0].anchor.y0-box.y0)<h*.7&&Math.abs(g[0].anchor.x0-box.x0)<h*2);
  if(group)group.push(candidate);else groups.push([candidate]);
 }
 const legs=groups.map(group=>{
  group.sort((a,b)=>a.review.length-b.review.length||b.confidence-a.confidence);
  const best={...group[0],review:[...group[0].review]};
  const complete=group.filter(c=>!c.review.length&&c.numericConfidence>=65);
  for(const key of ['player','market','side','line']) {
   const values=new Set(complete.map(c=>key==='player'?parlayNameKey(c[key]):c[key]));
   if(values.size>1){best.review.push(`The image readings disagree on ${key}. Check the screenshot.`);if(key==='line')best.line=null;}
  }
  const corroborated=group.some(c=>c!==group[0]&&c.line===best.line&&c.side===best.side&&c.numericConfidence>=65);
  if(best.numericConfidence<65&&!corroborated&&best.market!=='anytime_td'){best.line=null;best.review.push('The threshold needs review.');}
  if(best.confidence<65)best.review.push('Text needs review against the screenshot.');
  delete best.anchor;delete best.pass;delete best.confidence;delete best.numericConfidence;
  best.source_box={x:best.source_box.x0/width,y:best.source_box.y0/height,width:(best.source_box.x1-best.source_box.x0)/width,height:(best.source_box.y1-best.source_box.y0)/height};
  return best;
 }).sort((a,b)=>a.source_box.y-b.source_box.y||a.source_box.x-b.source_box.x);
 const all=passes.flatMap(p=>p.lines),headers=all.filter(l=>/parlay|total odds|combined odds/i.test(l.text));
 const counts=[...new Set(all.filter(l=>headers.includes(l)||/^\d{1,2}\s*[- ]?\s*(?:picks?|legs?|selections?)\b/i.test(l.text)).flatMap(l=>[...l.text.matchAll(/\b(\d{1,2})\s*[- ]?\s*(?:picks?|legs?|selections?)\b/gi)].map(m=>Number(m[1]))))];
 const declared_count=counts.length===1?counts[0]:null,warnings=[];
 if(counts.length>1)warnings.push('The printed selection count needs review.');
 if(declared_count!=null&&declared_count!==legs.length)warnings.push(`The slip says ${declared_count} selections, but ${legs.length} were found. Reconcile the count before saving.`);
 const prices=all.flatMap(l=>(l.words||[]).filter(w=>headers.some(header=>Math.abs((header.bbox.y0+header.bbox.y1-w.bbox.y0-w.bbox.y1)/2)<Math.max(header.bbox.y1-header.bbox.y0,w.bbox.y1-w.bbox.y0))).map(w=>({...w,price:w.text.match(/^[([]?([+\-]\d{3,6})[)\]]?$/)?.[1]})).filter(w=>w.price&&!w.struck&&w.confidence>=80));
 const priceValues=[...new Set(prices.map(w=>Number(w.price)))];
 const odds=priceValues.length===1?priceValues[0]:null;
 if(odds==null&&headers.length)warnings.push('Check the combined odds against the screenshot.');
 if(legs.some(l=>l.review.length))warnings.push('Some selections need review. Correct the marked fields.');
 if(legs.length>25)warnings.push('More than 25 selections were found. Choose a single slip.');
 return {legs,odds,odds_review:odds==null,declared_count,warnings,text:passes[0]?.lines.map(l=>l.text).join('\n')||'',reader:'layout-v1',count_review:counts.length>1||declared_count!=null&&declared_count!==legs.length};
}
