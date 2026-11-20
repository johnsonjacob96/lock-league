#!/usr/bin/env python3
"""Install/update this Mac's importer, using an existing private config.json."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

os.umask(0o077)
repo = Path(__file__).resolve().parents[2]
root = Path.home() / 'Library/Application Support/LockLeagueParlay'
config = json.loads((root / 'config.json').read_text())
for section in ('scripts/messages-parlays', 'functions/_shared'):
    shutil.copytree(repo / section, root / section, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__'))
(root / 'package.json').write_text(json.dumps({'private':True,'type':'module',
    'dependencies':{'@neondatabase/serverless':'0.9.5'}}))
subprocess.run(['npm','install','--prefix',str(root),'--omit=dev','--ignore-scripts',
    '--no-audit','--no-fund'], check=True)
label = 'com.lockleague.parlay-import'
plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
plist.parent.mkdir(parents=True, exist_ok=True)
payload = dict(Label=label, ProgramArguments=[sys.executable,
    str(root / 'scripts/messages-parlays/run.py')], RunAtLoad=True,
    StartCalendarInterval=[dict(Minute=m) for m in (0,15,30,45)],
    WorkingDirectory=str(root), ProcessType='Background', LowPriorityIO=True,
    StandardOutPath=str(root / 'scheduler.log'), StandardErrorPath=str(root / 'scheduler-error.log'),
    EnvironmentVariables={'PATH': str(Path(config['node']).parent) +
        ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'})
plist.write_bytes(plistlib.dumps(payload))
domain = 'gui/' + str(os.getuid())
subprocess.run(['launchctl','bootout',domain + '/' + label],capture_output=True)
subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True)
print('Installed ' + str(plist))
