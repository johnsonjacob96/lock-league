// This deterministic bridge owns credentials and writes. The vision process does not.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from '../../functions/_shared/db.js';
import { validateSlip } from '../../functions/_shared/parlays.js';
import { PROP_DEFS } from '../../functions/_shared/props.js';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
class ReviewRequired extends Error {}
const requireThat = (condition, reason) => { if (!condition) throw new ReviewRequired(reason); };
export function nightForDate(date) {
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Invalid date');
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  requireThat(day === 1 || day === 4, 'Only Monday/Thursday imports');
  return day === 1 ? 'Monday' : 'Thursday';
}

export function prepare(extraction, context, image, chatIdentifier) {
  requireThat(extraction.status === 'ready' && extraction.all_legs_visible === true, 'Receipt needs review');
  const imageIds = context.images.map(i => i.attachment_id);
  requireThat(extraction.images.length === imageIds.length &&
    new Set(extraction.images.map(i => i.attachment_id)).size === imageIds.length &&
    extraction.images.every(i => imageIds.includes(i.attachment_id)), 'Incomplete image classification');
  const classified = context.images.map(i => ({...i,
    kind: extraction.images.find(x => x.attachment_id === i.attachment_id).kind}));
  const receiptIndex = classified.findIndex(i => i.kind === 'placed_receipt');
  requireThat(receiptIndex >= 0, 'No placed receipt');
  requireThat(!classified.slice(0, receiptIndex).some(i => i.kind === 'unreadable'), 'Earlier unreadable image');
  const receipt = classified[receiptIndex];
  requireThat(receipt.attachment_id === extraction.receipt_attachment_id, 'Must use first receipt');
  requireThat(receipt.time.slice(0,10) === context.target_date, 'Receipt date mismatch');
  const games = context.games.filter(g => g.game_key === extraction.game_key);
  requireThat(games.length === 1, 'Ambiguous or absent game');
  requireThat(Number.isInteger(extraction.odds), 'Receipt odds required');
  requireThat(extraction.displayed_leg_count === extraction.legs.length && extraction.legs.length >= 2,
    'Incomplete leg count');
  const owners = new Set(), bets = new Set();
  const legs = extraction.legs.map(leg => {
    const members = context.members.filter(m => m.name === leg.member);
    requireThat(members.length === 1, 'Unknown member');
    requireThat(!owners.has(leg.member), 'Multiple legs for one member need review');
    owners.add(leg.member);
    requireThat(Array.isArray(leg.evidence_ids) && leg.evidence_ids.length > 0 &&
      leg.evidence_ids.every(id => context.messages.some(m => m.id === id && m.member === leg.member && m.text.trim())),
      'Assignment requires a message from that member');
    requireThat(context.allowed_markets.includes(leg.market) && leg.market !== 'manual', 'Unsupported market');
    const key = JSON.stringify([leg.player.toLowerCase(),leg.market,leg.side,leg.line]);
    requireThat(!bets.has(key), 'Duplicate leg');
    bets.add(key);
    return {...leg, member_id:members[0].id};
  });
  const hash = createHash('sha256').update(`messages:${chatIdentifier}:${context.target_date}:${receipt.attachment_id}`).digest('hex');
  const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const night = nightForDate(context.target_date);
  const body = {id, season:games[0].season, week:games[0].week, night,
    game_key:extraction.game_key, title:`${night==='Monday'?'MNF':'TNF'} — ${context.target_date}`,
    odds:extraction.odds, image, legs};
  try { return validateSlip(body, context.members.map(m => m.id)); }
  catch { throw new ReviewRequired('Slip did not pass app validation'); }
}

async function productionDb(config) {
  const path = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  const token = () => readFileSync(path,'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  const fetchProject = async () => {
    const auth = token();
    requireThat(auth, 'Wrangler OAuth login required');
    return fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/pages/projects/lock-league`,
      {headers:{Authorization:`Bearer ${auth}`},signal:AbortSignal.timeout(20000)});
  };
  let response = await fetchProject();
  if ([401,403].includes(response.status)) {
    // Let the official CLI renew its OAuth session. Never store another token.
    execFileSync(config.wrangler,['pages','deployment','list','--project-name','lock-league',
      '--environment','production','--json'], {stdio:'pipe',timeout:60000,
        env:{...process.env,CI:'true',CLOUDFLARE_ACCOUNT_ID:config.account_id}});
    response = await fetchProject();
  }
  requireThat(response.ok, 'Cloudflare project unavailable');
  const body = await response.json();
  requireThat(body.success, 'Cloudflare project unavailable');
  const vars = body.result.deployment_configs.production.env_vars;
  return sql(Object.fromEntries(Object.entries(vars).map(([k,v])=>[k,v.value])));
}

async function getContext(db,date) {
  const night = nightForDate(date);
  const members = await db`SELECT id,name FROM members ORDER BY id`;
  const games = await db`SELECT season,week,away||'@'||home AS game_key FROM games
    WHERE (kickoff_at AT TIME ZONE 'America/Chicago')::date=${date}::date ORDER BY kickoff_at`;
  const existing = await db`SELECT id,season,week,game_key FROM parlay_slips
    WHERE night=${night} AND (season,week,game_key) IN
    (SELECT season,week,away||'@'||home FROM games
     WHERE (kickoff_at AT TIME ZONE 'America/Chicago')::date=${date}::date)`;
  return {members,games,existing,allowed_markets:[...Object.keys(PROP_DEFS),'game_total','spread','moneyline']};
}

async function main() {
  const [action, folder] = process.argv.slice(2);
  requireThat(['context','publish'].includes(action) && folder, 'Invalid action');
  const config = json(process.argv[process.argv.indexOf('--config')+1]);
  const {target_date:date} = json(join(folder,'request.json'));
  const db = await productionDb(config);
  const fresh = await getContext(db,date);
  if (action === 'context') return fresh;
  const context = {...json(join(folder,'context.json')), ...fresh};
  requireThat(context.target_date === date, 'Context date mismatch');
  const extraction = json(join(folder,'extraction.json'));
  const imageInfo = context.images.find(i => i.attachment_id === extraction.receipt_attachment_id);
  requireThat(imageInfo && /^attachment-\d+\.jpg$/.test(imageInfo.file), 'Invalid image');
  const image = 'data:image/jpeg;base64,' + readFileSync(join(folder,imageInfo.file)).toString('base64');
  const slip = prepare(extraction,context,image,config.chat_identifier);
  const duplicate = fresh.existing.find(s => s.game_key === slip.game_key);
  if (duplicate) return {status:'already_exists',id:duplicate.id,
    verified_legs:slip.legs,odds:slip.odds};
  if (!process.argv.includes('--save')) return {status:'dry_run',slip:{...slip,image:'[private JPEG]'}};
  const creators = fresh.members.filter(m => m.name === config.self_member);
  requireThat(creators.length === 1, 'Creator missing');
  // Stable receipt UUID + guarded insert prevent retries from duplicating a slip.
  // Transaction lock coordinates concurrent automation instances before checking.
  const result = await db.transaction([
    db`SELECT pg_advisory_xact_lock(hashtext('lock-league-parlay-import'))`,
    db`INSERT INTO parlay_slips (id,season,week,night,game_key,title,odds,legs,image,created_by)
      SELECT ${slip.id},${slip.season},${slip.week},${slip.night},${slip.game_key},${slip.title},
        ${slip.odds},${JSON.stringify(slip.legs)}::jsonb,${slip.image},${creators[0].id}
      WHERE NOT EXISTS (SELECT 1 FROM parlay_slips WHERE season=${slip.season}
        AND week=${slip.week} AND night=${slip.night} AND game_key=${slip.game_key})
      ON CONFLICT(id) DO NOTHING RETURNING id`
  ]);
  if (!result[1].length) return {status:'already_exists'};
  const saved = (await db`SELECT id,legs,odds,image IS NOT NULL AS has_image FROM parlay_slips WHERE id=${slip.id}`)[0];
  requireThat(saved?.has_image && saved.odds === slip.odds && saved.legs.length === slip.legs.length,
    'Saved slip verification failed');
  return {status:'saved',id:slip.id,leg_count:slip.legs.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    if (error instanceof ReviewRequired) {
      console.log(JSON.stringify({status:'needs_review',note:error.message}));
      return;
    }
    // Provider errors can include SQL/URLs: never log their payloads or secrets.
    console.error('Parlay bridge failed (OAuth, network, or validation). No overwrite attempted.');
    process.exitCode=1;
  });
}
