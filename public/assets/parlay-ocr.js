// Read original-resolution image strips, not the compressed archive preview.
// Tall screenshots retain the same text size as short ones.
function parlayMergeOcrLines(lines) {
 const kept=[];
 for(const line of lines) {
  const duplicate=kept.findIndex(other=>Math.abs(other.y-line.y)<Math.max(other.height,line.height)*.45&&Math.abs(other.x-line.x)<60);
  if(duplicate<0)kept.push(line);
  else if(line.confidence>kept[duplicate].confidence)kept[duplicate]=line;
 }
 return kept.sort((a,b)=>Math.abs(a.y-b.y)<Math.min(a.height,b.height)*.35?a.x-b.x:a.y-b.y).map(l=>l.text).join('\n');
}
// Only discard a leading graphic token when a repeated subtitle corroborates
// the full player name AND OCR word geometry separates it from that name.
function parlayFilterLogoText(lines) {
 const anchors=lines.flatMap(l=>{
  const m=l.text.match(/^(.+?)\s*[-:|]\s*((?:total|alt|passing|rushing|receiving|receptions|completions|interceptions).*?)$/i);
  return m&&parlayCleanName(m[1]).split(/\s+/).length>=2&&parlayMarket(m[2])!=='manual'?[parlayCleanName(m[1])]:[];
 });
 const cleaned=lines.map(l=>{
  if(!l.words?.length)return l;
  for(const name of anchors) {
   const start=l.words.findIndex((w,i)=>{
    if(i<1||i>3||l.words.slice(0,i).map(x=>x.text).join(' ').length>12)return false;
    const rest=l.words.slice(i).map(x=>x.text).join(' ');
    const player=rest.split(/\s+(?:over|under|at least|\d)/i)[0];
    return parlayNameKey(player)===parlayNameKey(name);
   });
   if(start<1)continue;
   const prefix=l.words.slice(0,start),first=l.words[start],previous=prefix.at(-1);
   if(!first.bbox||!previous.bbox)continue;
   const h=Math.max(1,first.bbox.y1-first.bbox.y0),gap=first.bbox.x0-previous.bbox.x1;
   const graphic=gap>h*.7||prefix.some(w=>w.confidence<45||w.bbox&&w.bbox.y1-w.bbox.y0>h*1.5);
   if(!graphic)continue;
   const words=l.words.slice(start);
   return {...l,text:words.map(w=>w.text).join(' '),x:first.bbox.x0,words,confidence:words.reduce((sum,w)=>sum+(w.confidence||0),0)/words.length};
  }
  return l;
 });
 // A logo can also be its own OCR line to the left of the selection title.
 // Never remove a numeric threshold or a line without a corroborated name.
 return cleaned.filter(l=>!(!/\d/.test(l.text)&&l.text.length<=12&&cleaned.some(other=>other!==l&&anchors.some(name=>other.text.toLowerCase().startsWith(name.toLowerCase()))&&Math.abs(other.y-l.y)<other.height*.6&&l.right!=null&&l.right<other.x-other.height*.5)));
}
// Number confidence is separate from logo/name confidence on the same line.
function parlayUncertainThreshold(line) {
 if(!/\d/.test(line.text)||!/over|under|\+/i.test(line.text))return false;
 const words=line.words||[],direction=words.findIndex(w=>/over|under/i.test(w.text));
 const numbers=words.slice(Math.max(0,direction)).filter(w=>/\d/.test(w.text));
 return numbers.length?numbers.some(w=>w.confidence<65):line.confidence<65;
}
function parlayImproveContrast(canvas) {
 const ctx=canvas.getContext('2d',{willReadFrequently:true}),data=ctx.getImageData(0,0,canvas.width,canvas.height),p=data.data,samples=[];
 for(let i=0;i<p.length;i+=4*131)samples.push((p[i]+p[i+1]+p[i+2])/3);
 samples.sort((a,b)=>a-b);const dark=samples[Math.floor(samples.length/2)]<128;
 // Saturated sportsbook blue on charcoal loses contrast in ordinary grayscale.
 // Using the strongest ink channel preserves it, then presents dark text on white.
 for(let i=0;i<p.length;i+=4){const v=dark?255-Math.max(p[i],p[i+1],p[i+2]):Math.min(p[i],p[i+1],p[i+2]);p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;}
 ctx.putImageData(data,0,0);
}
async function parlayOcrWorker() {
 if(!window.Tesseract)await new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const timeout=setTimeout(()=>reject(Error('Image reader could not load. Retry or enter the legs manually.')),20000);
  script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(Error('Image reader is unavailable. Enter the legs manually or retry.'));};document.head.appendChild(script);
 });
 let timer,expired=false;
 const creation=Tesseract.createWorker('eng',1);
 creation.then(w=>{if(expired)w.terminate();},()=>{});
 try{return await Promise.race([creation,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Image reader could not load. Retry or enter the legs manually.'));},45000);})]);}finally{clearTimeout(timer);}
}
async function readParlayImage(file,draft) {
 if(file.size>15000000)throw Error('Choose a screenshot smaller than 15 MB.');
 const bitmap=await createImageBitmap(file);let worker,timer;
 try {
  const preview=document.createElement('canvas'),scale=Math.min(1,1400/bitmap.width,Math.sqrt(5000000/(bitmap.width*bitmap.height)));
  preview.width=Math.round(bitmap.width*scale);preview.height=Math.round(bitmap.height*scale);
  preview.getContext('2d').drawImage(bitmap,0,0,preview.width,preview.height);
  let image=preview.toDataURL('image/jpeg',.85);
  if(image.length>1500000)image=preview.toDataURL('image/jpeg',.6);
  if(image.length>1500000)throw Error('This screenshot is too large. Crop to the slip and retry.');
  draft.image=image;preview.width=preview.height=1;
  const width=Math.min(1800,Math.max(1200,bitmap.width)),ocrScale=width/bitmap.width;
  const height=Math.round(bitmap.height*ocrScale),tileHeight=1800,step=1500;
  const starts=[];for(let y=0;y<height;y+=step){starts.push(y);if(y+tileHeight>=height)break;}
  if(starts.length>12)throw Error('This screenshot is too tall to read reliably. Crop to a single slip.');
  worker=await parlayOcrWorker();
  let lines=[];const fallback=[];
  const read=async()=>{
   for(const [index,y] of starts.entries()) {
    const status=document.getElementById('parlay-ocr-status');if(status)status.textContent=`Reading slip section ${index+1} of ${starts.length}…`;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=Math.min(tileHeight,height-y);
    canvas.getContext('2d').drawImage(bitmap,0,y/ocrScale,bitmap.width,canvas.height/ocrScale,0,0,canvas.width,canvas.height);
    parlayImproveContrast(canvas);
    const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
    const found=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
    if(found.length)for(const l of found){const box=l.bbox;if(box&&l.text?.trim())lines.push({text:l.text.trim(),words:(l.words||[]).map(w=>({text:w.text,bbox:w.bbox,confidence:w.confidence})),right:box.x1,x:box.x0,y:y+(box.y0+box.y1)/2,height:Math.max(1,box.y1-box.y0),confidence:l.confidence||0});}
    else if(!data.text?.trim()){canvas.width=canvas.height=1;continue;}
    else if(starts.length===1)fallback.push(data.text||'');
    else throw Error('The reader could not locate all slip sections. Crop the screenshot or enter the legs manually.');
    canvas.width=canvas.height=1;
   }
   lines=parlayFilterLogoText(lines);
   const doc=parseParlayDocument(lines.length?parlayMergeOcrLines(lines):fallback.join('\n'));
   const normalize=s=>s.replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
   for(const leg of doc.legs) {
    const source=leg.source_text.split('\n').map(normalize),matched=lines.filter(l=>source.includes(normalize(l.text)));
    if(!matched.length)continue;
    const uncertainNumber=leg.market!=='anytime_td'&&matched.some(parlayUncertainThreshold);
    if(matched.some(l=>l.confidence<65)||uncertainNumber) {
     leg.review.push('Low-confidence text. Compare this leg with the original.');
     if(uncertainNumber)leg.line=null;
    }
    const top=Math.max(0,Math.min(...matched.map(l=>l.y-l.height/2))-18)/ocrScale;
    const bottom=Math.min(height,Math.max(...matched.map(l=>l.y+l.height/2))+18)/ocrScale;
    const crop=document.createElement('canvas');crop.width=Math.min(bitmap.width,1200);crop.height=Math.max(1,Math.round((bottom-top)*crop.width/bitmap.width));
    crop.getContext('2d').drawImage(bitmap,0,top,bitmap.width,bottom-top,0,0,crop.width,crop.height);
    leg.source_crop=crop.toDataURL('image/jpeg',.85);crop.width=crop.height=1;
   }
   if(doc.legs.some(l=>l.review.length)&&!doc.warnings.length)doc.warnings.push('Some legs need correction. Check each marked leg against the screenshot.');
   return doc;
  };
  return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Reading took too long. Crop the slip and retry, or enter legs manually.')),120000);})]);
 }finally{clearTimeout(timer);bitmap.close();if(worker)await worker.terminate();}
}
