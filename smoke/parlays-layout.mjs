import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({});
for(const f of ['parlay-parser.js','parlay-layout.js'])vm.runInContext(readFileSync(new URL('../public/assets/'+f,import.meta.url),'utf8'),context);
const plain=x=>JSON.parse(JSON.stringify(x));
const expected=JSON.parse(readFileSync(new URL('./assets/parlay-images/expected.json',import.meta.url)));
const captures=JSON.parse(readFileSync(new URL('./assets/parlay-images/ocr.json',import.meta.url)));
for(const fixture of expected)test(`actual OCR geometry replay: ${fixture.image}`,()=>{
 const c=captures.find(x=>x.image===fixture.image),doc=plain(context.parseParlayLayout(c.passes,c.width,c.height));
 assert.deepEqual(doc.legs.map(l=>[l.player,l.market,l.side,l.line]),fixture.legs);
 assert.equal(doc.odds,fixture.odds);assert.equal(doc.declared_count,fixture.declared_count);assert.deepEqual(doc.warnings,[]);
});
function line(text,y,x=100) {
 let left=x;const words=text.split(' ').map(text=>{const width=text.length*10;const w={text,confidence:96,bbox:{x0:left,x1:left+width,y0:y,y1:y+24}};left+=width+8;return w;});
 return {text,confidence:96,bbox:{x0:x,y0:y,x1:left,y1:y+24},words};
}
function read(rows) {return plain(context.parseParlayLayout([{mode:'gray',lines:rows}],1200,1800));}
test('cash-out above selections does not terminate reading, repeated player markets remain separate',()=>{
 const doc=read([line('2 Pick Parlay +900',20),line('Cash Out $5.00',80),line('Josh Allen Over 30.5',200),line('JOSH ALLEN - RUSHING YARDS',245),line('Josh Allen',350),line('ANY TIME TOUCHDOWN SCORER',395)]);
 assert.equal(doc.legs.length,2);assert.equal(doc.count_review,false);assert.deepEqual(doc.legs.map(l=>l.market),['rush_yds','anytime_td']);
});
test('market-first and title-first arrangements pair locally; N+ stays inclusive',()=>{
 const doc=read([line('Matthew Stafford Passing Yards',200),line('240+',245),line('Rashee Rice 6+ Receptions',350),line('RASHEE RICE - ALT RECEPTIONS',395)]);
 assert.deepEqual(doc.legs.map(l=>[l.player,l.side,l.line]),[['Matthew Stafford','atleast',240],['Rashee Rice','atleast',6]]);
});
test('neighboring subjects never complete each other and unsupported markets remain visible',()=>{
 const doc=read([line('Josh Allen Over 30.5',200),line('PATRICK MAHOMES - RUSHING YARDS',245),line('Davante Adams',350),line('First Touchdown Scorer',395)]);
 assert.equal(doc.legs.length,2);assert.ok(doc.legs.every(l=>l.review.length));assert.equal(doc.legs[1].market,'');
});
test('missing subtitle preserves an unresolved selection and a missing printed leg blocks completeness',()=>{
 const doc=read([line('4 selections Parlay',20),line('Josh Allen Over 30.5',200),line('JOSH ALLEN - RUSHING YARDS',245),line('Sam LaPorta Over 4.5',320),line('Jahmyr Gibbs 30+',450),line('JAHMYR GIBBS - RECEIVING YARDS',495)]);
 assert.equal(doc.legs.length,3);assert.equal(doc.legs[1].market,'');assert.equal(doc.count_review,true);assert.equal(doc.declared_count,4);
});
test('a cross-pass numeric disagreement requires correction',()=>{
 const rows=[line('Josh Allen Over 30.5',200),line('JOSH ALLEN - RUSHING YARDS',245)];
 const altered=[line('Josh Allen Over 80.5',200),line('JOSH ALLEN - RUSHING YARDS',245)];
 const doc=context.parseParlayLayout([{mode:'gray',lines:rows},{mode:'channel',lines:altered}],1200,1800);
 assert.equal(doc.legs.length,1);assert.equal(doc.legs[0].line,null);assert.match(doc.legs[0].review.join(' '),/disagree/);
});
test('two columns on the same row do not merge distinct selections',()=>{
 const doc=read([line('Sam LaPorta',200,40),line('Anytime TD Scorer',245,40),line('Josh Allen',200,650),line('Anytime TD Scorer',245,650)]);
 assert.deepEqual(doc.legs.map(l=>l.player),['Sam LaPorta','Josh Allen']);
});
test('ambiguous active prices remain blank and crossed prices cannot win',()=>{
 let a=line('Same Game Parlay +800 +1000',20);
 assert.equal(read([a]).odds,null);
 a.words.find(w=>w.text==='+800').struck=true;
 assert.equal(read([a]).odds,1000);
});
test('a split decimal is unresolved rather than becoming a different threshold',()=>{
 const doc=read([line('Josh Allen Over 30. 5',200),line('JOSH ALLEN - RUSHING YARDS',245)]);
 assert.equal(doc.legs.length,1);assert.equal(doc.legs[0].line,null);assert.ok(doc.legs[0].review.length);
});
