import subprocess, sys
from pathlib import Path
patch = Path(sys.argv[1])
if not patch.is_file() or patch.stat().st_size > 500_000:
    raise SystemExit('Missing or oversized patch')
if not patch.read_bytes().strip():
    raise SystemExit('Empty patch')
subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
subprocess.run(['git', 'apply', '--index', str(patch)], check=True)
paths = subprocess.check_output(['git','diff','--cached','--name-only','-z']).decode().split('\0')[:-1]
if not paths or len(paths) > 20:
    raise SystemExit('Expected 1 to 20 changed files')
for path in paths:
    parts = Path(path).parts
    if any(p.startswith('.') for p in parts) or parts[0] in ('agent-output','monitor-output','node_modules') or path == 'prior-agent-report.md' or 'node_modules' in parts or Path(path).name.startswith('AGENTS'):
        raise SystemExit('Protected path: ' + path)
    mode = subprocess.check_output(['git','ls-files','-s','--',path]).decode().split(' ',1)[0]
    if mode and mode not in ('100644','100755'):
        raise SystemExit('Only ordinary files may be published: ' + path)
print('Accepted patch touching', len(paths), 'files')
