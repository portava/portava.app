#!/usr/bin/env python3
"""Build the real OpenMLS Rust/Swift FFI and execute it in fresh simulator processes, including old-session compatibility.
Creates and removes its own simulator; never selects physical/user devices or production.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--module', required=True, help='Current expo-openmls Rust module source (a staged copy is allowed)')
parser.add_argument('--output', required=True, help='New private output directory outside module source')
parser.add_argument('--target-dir', required=True, help='Dedicated Cargo output, never the shared Android target')
parser.add_argument('--bindings', help='Reuse Swift bindings generated from the current UDL; otherwise generate them locally')
parser.add_argument('--runtime', help='Installed iOS simulator runtime identifier; defaults to newest available iOS runtime')
a = parser.parse_args()
module, out, target = (Path(value).resolve() for value in [a.module, a.output, a.target_dir])
fixture = Path(__file__).resolve().with_name('OpenMlsRuntimeFixture.swift')
if out.exists() or out.is_relative_to(module): parser.error('output must be new and outside module source')
if target.is_relative_to(module): parser.error('Cargo target must be outside module source and isolated from Android')
out.mkdir(parents=True, mode=0o700)
env = dict(os.environ, CARGO_TARGET_DIR=str(target))
commands = []
def run(command, log, cwd=None, timeout=180, environment=None):
    commands.append(command)
    with (out/log).open('w') as stream:
        subprocess.run(command, cwd=cwd, env=environment, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=timeout)
def read_json(command):
    commands.append(command)
    return json.loads(subprocess.check_output(command, text=True, timeout=30))
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

simulator = None
snapshot = out/'session-fixture.json'
try:
    run(['cargo', 'build', '--locked', '--offline', '--release', '--target', 'aarch64-apple-ios-sim', '--lib'], 'rust-build.log', cwd=module, timeout=600, environment=env)
    if a.bindings:
        bindings = Path(a.bindings).resolve()
    else:
        bindings = out/'bindings'; bindings.mkdir()
        run(['cargo', 'run', '--locked', '--offline', '--bin', 'uniffi-bindgen', '--', 'generate', 'src/openmls.udl', '--language', 'swift', '--out-dir', str(bindings)], 'bindgen.log', cwd=module, timeout=600, environment=env)
    for name in ['openmls.swift', 'openmlsFFI.h', 'openmlsFFI.modulemap']:
        if not (bindings/name).is_file(): raise RuntimeError('Missing generated binding: '+name)
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
    static = target/'aarch64-apple-ios-sim/release/libexpo_openmls.a'
    executable = out/'OpenMlsRuntimeFixture'
    run(['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios15.1-simulator', '-parse-as-library',
         '-I', str(bindings), '-Xcc', '-fmodule-map-file='+str(bindings/'openmlsFFI.modulemap'), str(bindings/'openmls.swift'), str(fixture), str(static),
         '-framework', 'Foundation', '-framework', 'UIKit', '-framework', 'Security', '-o', str(executable)], 'swift-build.log')
    run(['xcrun', 'vtool', '-show-build', str(executable)], 'mach-o-platform.log')
    if 'platform IOSSIMULATOR' not in (out/'mach-o-platform.log').read_text(): raise RuntimeError('Executable is not an iOS simulator target')
    runtimes = read_json(['xcrun', 'simctl', 'list', 'runtimes', '--json'])['runtimes']
    candidates = [r for r in runtimes if r.get('isAvailable') and '.iOS-' in r['identifier'] and (not a.runtime or r['identifier'] == a.runtime)]
    if not candidates: raise RuntimeError('No installed available iOS simulator runtime')
    runtime = max(candidates, key=lambda r: tuple(int(n) for n in r['version'].split('.')))
    available = read_json(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])['devices'].get(runtime['identifier'], [])
    template = next((device for device in available if 'iPhone' in device.get('deviceTypeIdentifier', '')), None)
    if not template: raise RuntimeError('No compatible iPhone simulator type available for runtime')
    name = 'Portava MLS Validation '+uuid.uuid4().hex[:8]
    create = ['xcrun', 'simctl', 'create', name, template['deviceTypeIdentifier'], runtime['identifier']]
    commands.append(create)
    simulator = subprocess.check_output(create, text=True, timeout=30).strip()
    run(['xcrun', 'simctl', 'boot', simulator], 'simulator-boot.log', timeout=60)
    run(['xcrun', 'simctl', 'bootstatus', simulator, '-b'], 'simulator-ready.log', timeout=180)
    reports = []
    for mode, expected in [('create', 7), ('restore', 9), ('legacy', 5)]:
        run(['xcrun', 'simctl', 'spawn', simulator, str(executable), mode, str(module/'fixtures/openmls-0.6.0-session.json' if mode == 'legacy' else snapshot)], mode+'.log', timeout=60)
        json_lines = [line for line in (out/(mode+'.log')).read_text().splitlines() if line.startswith('{')]
        if len(json_lines) != 1: raise RuntimeError(mode+' did not produce exactly one report')
        report = json.loads(json_lines[0])
        if report.get('mode') != mode or report.get('checkCount') != expected or report.get('physicalDevice') is not False or report.get('system') != 'iOS':
            raise RuntimeError('Incomplete runtime evidence: '+mode)
        reports.append(report)
    source_paths = [module/'src/lib.rs', module/'src/openmls.udl', module/'Cargo.toml', module/'Cargo.lock', module/'build.rs',
                    module/'fixtures/openmls-0.6.0-session.json', bindings/'openmls.swift', bindings/'openmlsFFI.h', bindings/'openmlsFFI.modulemap', fixture]
    evidence = {'runtimeExecuted': True, 'physicalDevice': False, 'expoReactNativeRuntimeExercised': False,
                'runtime': runtime['identifier'], 'simulator': simulator, 'simulatorName': name, 'sdk': sdk,
                'rustTarget': 'aarch64-apple-ios-sim', 'processes': 3, 'checks': sum(r['checkCount'] for r in reports), 'reports': reports,
                'sourceSha256': {str(path): digest(path) for path in source_paths}, 'staticLibrarySha256': digest(static), 'executableSha256': digest(executable)}
    (out/'evidence.json').write_text(json.dumps(evidence, indent=2)+'\n')
    print('PASS: 21 checks across three actual iOS simulator processes; '+str(out/'evidence.json'))
finally:
    snapshot.unlink(missing_ok=True)  # Remove all synthetic private session material, even after failure.
    if simulator:
        subprocess.run(['xcrun', 'simctl', 'shutdown', simulator], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        subprocess.run(['xcrun', 'simctl', 'delete', simulator], check=True, timeout=30)
    (out/'commands.json').write_text(json.dumps(commands, indent=2)+'\n')
