// Browser-only image recognition. No screenshot is sent to an OCR service.
// Legacy text helpers remain available to the text-parser regression suite.
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
// The full image is read in complementary contrast modes. Every word retains
// its coordinates; thresholded mode is only used for high-contrast metadata.
function parlayStrikeScore(pixels,box) {
 const lum=(x,y)=>{const i=(Math.max(0,Math.min(pixels.height-1,Math.round(y)))*pixels.width+Math.max(0,Math.min(pixels.width-1,Math.round(x))))*4;return .299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2];};
 const w=box.x1-box.x0,h=box.y1-box.y0;
 const bg=[lum(box.x0-4,box.y0-4),lum(box.x1+4,box.y0-4),lum(box.x0-4,box.y1+4),lum(box.x1+4,box.y1+4)].sort((a,b)=>a-b)[2];
 let score=0;
 // Crossed-out odds can be horizontal or diagonal. Require a near-continuous
 // stroke through the word, not merely a minus sign or a digit's middle bar.
 for(let start=.15;start<=.85;start+=.025)for(let slope=-.8;slope<=.8;slope+=.025){
  let ink=0,total=0;
  for(let x=.05;x<=.95;x+=.01){const y=start+slope*(x-.5);if(y<0||y>1)continue;total++;if(Math.abs(lum(box.x0+x*w,box.y0+y*h)-bg)>35)ink++;}
  if(total>80)score=Math.max(score,ink/total);
 }
 return score;
}
async function readParlayImage(file,draft) {
 if(file.size>15000000)throw Error('Choose a screenshot smaller than 15 MB.');
 const bitmap=await createImageBitmap(file);let worker,timer,canvas;
 try {
  const pixels=bitmap.width*bitmap.height;
  if(pixels>12000000||bitmap.height>16000||bitmap.width>6000)throw Error('This image is too large to read on this device. Choose a single slip or enter the selections manually.');
  const preview=document.createElement('canvas'),previewScale=Math.min(1,1400/bitmap.width,Math.sqrt(5000000/pixels));
  preview.width=Math.round(bitmap.width*previewScale);preview.height=Math.round(bitmap.height*previewScale);preview.getContext('2d').drawImage(bitmap,0,0,preview.width,preview.height);
  let image=preview.toDataURL('image/jpeg',.85);if(image.length>1500000)image=preview.toDataURL('image/jpeg',.6);
  if(image.length>1500000)throw Error('This screenshot is too large to save. Choose a single slip.');
  preview.width=preview.height=1;
  const scale=Math.min(Math.max(1,Math.min(1.5,2400/bitmap.width)),Math.sqrt(12000000/pixels));
  canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const original=ctx.getImageData(0,0,canvas.width,canvas.height),passes=[];
  worker=await parlayOcrWorker();
  const read=async()=>{
   await worker.setParameters({tessedit_pageseg_mode:'11'});
   for(const [index,mode] of ['gray','channel','binary'].entries()){
    const status=document.getElementById('parlay-ocr-status');if(status)status.textContent=`Reading the full screenshot · ${index+1} of 3…`;
    ctx.putImageData(original,0,0);
    if(mode==='channel')parlayImproveContrast(canvas);
    else {
     const data=ctx.getImageData(0,0,canvas.width,canvas.height),p=data.data;
     for(let i=0;i<p.length;i+=4){const v=.299*p[i]+.587*p[i+1]+.114*p[i+2];p[i]=p[i+1]=p[i+2]=mode==='binary'?(v>128?255:0):v;}
     ctx.putImageData(data,0,0);
    }
    const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
    const lines=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[])).filter(l=>l.bbox&&l.words?.length).map(l=>({text:l.text.trim(),bbox:l.bbox,confidence:l.confidence,words:l.words.map(w=>({text:w.text,bbox:w.bbox,confidence:w.confidence,struck:/^[+\-]\d{3,6}$/.test(w.text)&&parlayStrikeScore(original,w.bbox)>.9}))}));
    passes.push({mode,lines});
   }
   if(!passes.some(p=>p.lines.length))throw Error('No readable selections found. Try a clearer screenshot or add selections manually.');
   const doc=parseParlayLayout(passes,canvas.width,canvas.height);
   draft.image=image;
   return doc;
  };
  return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Reading took too long on this device. Try again or add selections manually.')),120000);})]);
 }finally{clearTimeout(timer);if(worker)await worker.terminate();if(canvas)canvas.width=canvas.height=1;bitmap.close();}
}
