#!/usr/bin/env python3
"""Local Messages → bounded vision extraction → validated Lock League import.

No secrets in config/state. LaunchAgent ticks cheaply; model runs only when due.
"""
import argparse
import datetime as dt
import fcntl
import glob
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from zoneinfo import ZoneInfo

CT = ZoneInfo('America/Chicago')
APPLE_EPOCH = 978307200
HERE = Path(__file__).resolve().parent
RUNTIME = Path.home() / 'Library/Application Support/LockLeagueParlay'
TERMINAL = {'saved', 'already_exists', 'needs_review', 'no_game', 'missed'}


def due_dates(now, start, state):
    """Catch up every missed date since install, independent of Mac timezone/DST."""
    now = now.astimezone(CT)
    day = dt.date.fromisoformat(start)
    result = []
    while day <= now.date():
        key = day.isoformat()
        entry = state.get(key, {})
        due = dt.datetime.combine(day, dt.time(19, 30), CT)
        retry = dt.datetime.combine(day, dt.time(20, 30), CT)
        if day.weekday() in (0, 3) and now >= due and entry.get('status') not in TERMINAL:
            if entry.get('attempts', 0) == 0 or (entry.get('attempts', 0) < 2 and now >= retry
                    and now.timestamp() - entry.get('last_attempt', 0) >= 3600):
                result.append(key)
        day += dt.timedelta(days=1)
    return result


def read_json(path, fallback=None):
    return json.loads(path.read_text()) if path.exists() else fallback


def write_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2))
    tmp.replace(path)


def message_text(row):
    if row['text']:
        return row['text']
    blob = row['attributedBody'] or b''
    pos = blob.find(b'NSString')
    if pos < 0:
        return ''
    # Class/version/object-reference bytes vary between macOS releases. The
    # NSString payload is the typed '+' string immediately after that class.
    marker = blob.find(b'\x01+', pos + len(b'NSString'), pos + 40)
    if marker < 0:
        raise ValueError('Unreadable attributed message')
    data = blob[marker + 2:]
    if not data:
        return ''
    size, offset = data[0], 1
    if size in (0x81, 0x82):
        width = 2 if size == 0x81 else 4
        if len(data) < width + 1:
            raise ValueError('Unreadable attributed message')
        size = int.from_bytes(data[1:width+1], 'little')
        offset += width
    if size > 10000 or size + offset > len(data):
        raise ValueError('Unreadable attributed message')
    return data[offset:offset+size].decode('utf-8')


def connect_readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def resolve_senders(db, chat_id, config):
    """Resolve only this group's handles through exact normalized contact numbers."""
    handles = db.execute('''SELECT DISTINCT h.ROWID,h.id FROM handle h JOIN message m
        ON m.handle_id=h.ROWID JOIN chat_message_join j ON j.message_id=m.ROWID
        WHERE j.chat_id=? AND m.is_from_me=0''', (chat_id,)).fetchall()
    contacts = [connect_readonly(Path(p)) for p in glob.glob(str(Path.home() /
        'Library/Application Support/AddressBook/Sources/*/AddressBook-v*.abcddb'))]
    senders = {}
    try:
        for h in handles:
            number = ''.join(c for c in h['id'] if c.isdigit())[-10:]
            names = set()
            if len(number) == 10:
                for c in contacts:
                    rows = c.execute('''SELECT p.ZFULLNUMBER,r.ZFIRSTNAME,r.ZLASTNAME
                        FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK=p.ZOWNER
                        WHERE p.ZLASTFOURDIGITS=?''', (number[-4:],)).fetchall()
                    for r in rows:
                        if ''.join(x for x in r['ZFULLNUMBER'] or '' if x.isdigit())[-10:] == number:
                            name = ' '.join(x for x in [r['ZFIRSTNAME'], r['ZLASTNAME']] if x)
                            if name in config['contact_members']:
                                names.add(config['contact_members'][name])
            senders[h['ROWID']] = next(iter(names)) if len(names) == 1 else None
    finally:
        for c in contacts:
            c.close()
    return senders


def collect(date, config, folder):
    day = dt.date.fromisoformat(date)
    begin = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(), CT)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), CT)
    epoch = lambda x: int((x.timestamp() - APPLE_EPOCH) * 1e9)
    with connect_readonly(Path.home() / 'Library/Messages/chat.db') as db:
        chats = db.execute('SELECT ROWID,display_name FROM chat WHERE chat_identifier=?',
                           (config['chat_identifier'],)).fetchall()
        if len(chats) != 1 or chats[0]['display_name'] != 'Lock League':
            raise ValueError('Exact Lock League chat not found')
        chat = chats[0]['ROWID']
        senders = resolve_senders(db, chat, config)
        rows = db.execute('''SELECT m.* FROM message m JOIN chat_message_join j
            ON j.message_id=m.ROWID WHERE j.chat_id=? AND m.date>=? AND m.date<?
            AND COALESCE(m.associated_message_type,0)<2000 ORDER BY m.date,m.ROWID''',
                          (chat, epoch(begin), epoch(end))).fetchall()
        if len(rows) > 800:
            raise ValueError('Too many messages; review instead of truncating the thread')
        messages, images = [], []
        for r in rows:
            stamp = dt.datetime.fromtimestamp(r['date']/1e9 + APPLE_EPOCH, CT)
            text = message_text(r)
            messages.append(dict(id=r['ROWID'], guid=r['guid'], time=stamp.isoformat(),
                member=config['self_member'] if r['is_from_me'] else senders.get(r['handle_id']),
                text=text, thread_originator_guid=r['thread_originator_guid']))
            if stamp.date() != day:
                continue
            attachments = db.execute('''SELECT a.ROWID,a.filename,a.mime_type FROM attachment a
                JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=?
                ORDER BY a.ROWID''', (r['ROWID'],)).fetchall()
            for a in attachments:
                if not (a['mime_type'] or '').startswith('image/'):
                    continue
                source = Path(a['filename'] or '').expanduser().resolve()
                source.relative_to((Path.home() / 'Library/Messages/Attachments').resolve())
                if not source.is_file() or source.stat().st_size > 20_000_000:
                    raise ValueError('Image missing, not downloaded, or too large')
                dest = folder / ('attachment-%s.jpg' % a['ROWID'])
                subprocess.run(['/usr/bin/sips', '-s', 'format', 'jpeg', '-s', 'formatOptions',
                    '85', '-Z', '2800', str(source), '--out', str(dest)], check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
                images.append(dict(attachment_id=a['ROWID'], message_id=r['ROWID'],
                    time=stamp.isoformat(), file=dest.name))
        if len(images) > 12:
            raise ValueError('Too many images; review instead of skipping earlier receipts')
    return dict(target_date=date, messages=messages, images=images)


def schema():
    def obj(properties):
        return dict(type='object', properties=properties, required=list(properties), additionalProperties=False)
    string = {'type': 'string'}
    integer = {'type': 'integer'}
    return obj(dict(status={'type':'string','enum':['ready','not_found','needs_review']}, note=string,
        receipt_attachment_id={'type':['integer','null']}, game_key={'type':['string','null']},
        odds={'type':['integer','null']}, all_legs_visible={'type':'boolean'}, displayed_leg_count=integer,
        images={'type':'array','items':obj(dict(attachment_id=integer,
            kind={'type':'string','enum':['placed_receipt','builder','other','unreadable']}))},
        legs={'type':'array','items':obj(dict(player=string,market=string,side=string,
            line={'type':['number','null']},member=string,
            evidence_ids={'type':'array','items':integer}))}))


def bridge(config, action, folder, save=False):
    cmd = [config['node'], str(HERE / 'publish.mjs'), action, str(folder),
           '--config', str(RUNTIME / 'config.json')]
    if save:
        cmd.append('--save')
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode:
        # Do not copy provider error bodies/SQL/credentials into persistent logs.
        raise RuntimeError('Production bridge failed; check OAuth/network or validation')
    return json.loads(result.stdout)


def model_binary(config):
    configured = Path(config['codex'])
    if configured.exists():
        return str(configured)
    candidates = glob.glob(str(Path.home() / '.vscode/extensions/openai.chatgpt-*/bin/macos-aarch64/codex'))
    if not candidates:
        raise RuntimeError('Codex executable unavailable')
    return max(candidates, key=os.path.getmtime)


def run_date(date, config, save, folder):
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json(folder / 'request.json', {'target_date': date})
    production = bridge(config, 'context', folder)
    if save and production['existing']:
        return {'status': 'already_exists', 'ids': [s['id'] for s in production['existing']]}
    if not production['games']:
        return {'status': 'no_game'}
    context = collect(date, config, folder)
    context.update(production)
    write_json(folder / 'context.json', context)
    if not context['images']:
        return {'status': 'not_found', 'note': 'No images yet'}
    write_json(folder / 'schema.json', schema())
    cmd = [model_binary(config), 'exec', '--ignore-user-config', '--skip-git-repo-check',
           '--sandbox', 'read-only', '--ephemeral', '--color', 'never',
           '-c', 'model_reasoning_effort="high"', '-C', str(folder),
           '--output-schema', str(folder / 'schema.json'),
           '--output-last-message', str(folder / 'extraction.json')]
    for image in context['images']:
        cmd += ['-i', str(folder / image['file'])]
    cmd.append('-')
    prompt = (HERE / 'reader-prompt.txt').read_text() + '\nCONTEXT JSON:\n' + json.dumps(context)
    with (folder / 'reader.log').open('w') as log:
        subprocess.run(cmd, input=prompt, text=True, stdout=log, stderr=log, timeout=900, check=True)
    extracted = read_json(folder / 'extraction.json')
    if extracted['status'] != 'ready':
        return {'status': extracted['status'], 'note': extracted['note']}
    return bridge(config, 'publish', folder, save)


def notify(message):
    # Fixed own-device notification; never messages the group.
    script = 'on run argv\ndisplay notification (item 1 of argv) with title "Lock League parlay"\nend run'
    subprocess.run(['/usr/bin/osascript', '-e', script, message], capture_output=True, timeout=15)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', help='Replay a date without writes (unless --save is supplied)')
    parser.add_argument('--save', action='store_true')
    parser.add_argument('--probe', action='store_true', help='Read-only Messages/Contacts/OAuth health check')
    args = parser.parse_args()
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (RUNTIME / 'run.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        config = read_json(RUNTIME / 'config.json')
        if args.probe:
            folder = RUNTIME / 'probe'
            folder.mkdir(exist_ok=True)
            date = dt.datetime.now(CT).date().isoformat()
            collected = collect(date, config, folder)
            write_json(folder / 'request.json', {'target_date': date})
            production = bridge(config, 'context', folder)
            print(json.dumps({'probe':'ok','messages':len(collected['messages']),
                              'members':len(production['members']), 'games':len(production['games'])}))
            return
        if args.date:
            print(json.dumps(run_date(args.date, config, args.save, RUNTIME / 'replays' / args.date)))
            return
        state = read_json(RUNTIME / 'state.json', {})
        for date, entry in state.items():
            if entry.get('status') not in TERMINAL and entry.get('attempts', 0) >= 2:
                entry['status'] = 'missed'
                notify(date + ': interrupted import needs review. Check LockLeagueParlay/state.json.')
        write_json(RUNTIME / 'state.json', state)
        now = dt.datetime.now(CT)
        dates = due_dates(now, config['start_date'], state)
        if dates:
            # A macOS privacy block is setup, not a failed extraction. Do not
            # exhaust the two attempts before the owner enables access.
            health_file = RUNTIME / 'health.json'
            try:
                with connect_readonly(Path.home() / 'Library/Messages/chat.db') as db:
                    chat = db.execute('SELECT ROWID FROM chat WHERE chat_identifier=?',
                                      (config['chat_identifier'],)).fetchone()
                    if chat:
                        resolve_senders(db, chat['ROWID'], config)
            except sqlite3.DatabaseError:
                health = read_json(health_file, {})
                if health.get('status') != 'blocked_permissions':
                    notify('Enable Python Full Disk Access for the scheduled Messages reader.')
                write_json(health_file, {'status':'blocked_permissions', 'checked_at':now.isoformat()})
                return
            write_json(health_file, {'status':'ok', 'checked_at':now.isoformat()})
        for date in dates:
            prior = state.get(date, {})
            attempt = prior.get('attempts', 0) + 1
            state[date] = {'status':'running','attempts':attempt,'last_attempt':now.timestamp()}
            write_json(RUNTIME / 'state.json', state)  # crash cannot trigger unbounded model retries
            try:
                result = run_date(date, config, True, RUNTIME / 'runs' / date / str(attempt))
            except Exception as error:
                result = {'status':'error','note':type(error).__name__ + ': processing failed; review local run'}
            if result['status'] in ('error', 'not_found') and attempt >= 2:
                result['status'] = 'missed'
            state[date].update(result)
            write_json(RUNTIME / 'state.json', state)
            print(json.dumps({'date':date, **state[date]}), flush=True)
            if result['status'] in ('saved', 'needs_review', 'missed'):
                notify(date + (': parlay imported.' if result['status']=='saved'
                       else ': import needs review. Check LockLeagueParlay/state.json.'))


if __name__ == '__main__':
    main()
