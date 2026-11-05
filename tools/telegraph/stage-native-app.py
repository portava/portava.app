#!/usr/bin/env python3
"""Copy current app sources into /tmp for a separate lockfile-based native build.
Does not copy dependency stores, native build outputs, credentials, or dotenv files.
"""
from pathlib import Path
import argparse, hashlib, json, shutil
parser = argparse.ArgumentParser()
parser.add_argument('app_source', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
source = args.app_source.resolve(); destination = args.destination.resolve()
if not destination.is_relative_to(Path('/tmp').resolve()): raise SystemExit('Destination must be under /tmp')
if destination.exists(): raise SystemExit('Choose a fresh destination; existing builds are not overwritten')
if not (source/'pnpm-lock.yaml').is_file(): raise SystemExit('App pnpm lockfile is required')
def ignore(directory, names):
    ignored = []
    for name in names:
        path = Path(directory)/name
        if name.startswith('.env') or path.suffix in {'.jks', '.p8', '.p12', '.mobileprovision', '.pem', '.key'}:
            ignored.append(name)
        elif path.is_dir() and name in {'node_modules', '.git', '.expo', 'target', 'build', 'dist', 'static-build', 'web-build', '.gradle', '.cxx', 'Pods', 'Rust'}:
            ignored.append(name)
        elif Path(directory)==source and name in {'android','ios'}:
            ignored.append(name)
    return ignored
shutil.copytree(source, destination, ignore=ignore)
files = {}
for path in destination.rglob('*'):
    if path.is_file(): files[str(path.relative_to(destination))] = hashlib.sha256(path.read_bytes()).hexdigest()
(destination/'native-source-snapshot.json').write_text(json.dumps({'source':str(source),'files':files},indent=2)+'\n')
print(destination)
