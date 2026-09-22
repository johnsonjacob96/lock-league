// Test-only CDN transport: use the exact remote engine assets, cached locally.
// curl also avoids local browser certificate failures. No OCR is stubbed.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export async function ocrBrowserTransport(context) {
 const cache=join(tmpdir(),'lock-league-ocr-assets');await mkdir(cache,{recursive:true});
 await context.route(/https:\/\/(?:cdn.jsdelivr.net|tessdata.projectnaptha.com)\//,async route=>{
  const url=route.request().url(),path=join(cache,createHash('sha256').update(url).digest('hex'));
  try {
   let body;try{body=await readFile(path);}catch{body=(await run('curl',['-fsSL','--max-time','45',url],{encoding:'buffer',maxBuffer:30000000})).stdout;await writeFile(path,body);}
   await route.fulfill({body,headers:{'access-control-allow-origin':'*'},contentType:url.endsWith('.js')?'text/javascript':'application/octet-stream'});
  }catch{await route.abort();}
 });
}
