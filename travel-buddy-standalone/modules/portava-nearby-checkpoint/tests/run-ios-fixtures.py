#!/usr/bin/env python3
"""Compile actual Swift sources against a real, current-compiler Expo core build.
Does not install pods, alter dependencies, sign an app or claim radio hardware proof.
"""
import argparse, hashlib, json, shlex, subprocess
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', required=True)
p.add_argument('--expo-products', required=True, help='Directory containing ExpoModulesCore.modulemap and .swiftmodule')
p.add_argument('--clang-response-file', required=True, help='Existing Expo core Xcode compilation response file, for real include/framework paths')
a = p.parse_args()
module = Path(__file__).resolve().parent.parent
out = Path(a.output).resolve()
if out.exists() or out.is_relative_to(module): p.error('output must be a new directory outside source')
out.mkdir(parents=True)
sources = sorted((module/'ios').glob('*.swift'))
core = Path(a.expo_products).resolve()
assert (core/'ExpoModulesCore.modulemap').is_file()
sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
cmd = ['xcrun', 'swiftc', '-emit-object', '-whole-module-optimization', '-parse-as-library', '-sdk', sdk,
       '-target', 'arm64-apple-ios15.1-simulator', '-module-name', 'PortavaNearbyCheckpoint', '-I', str(core),
       '-module-cache-path', str(out/'module-cache'), '-o', str(out/'PortavaNearbyCheckpoint.o')]
for arg in shlex.split(Path(a.clang_response_file).read_text()):
    if arg.startswith(('-I', '-F')): cmd.append(arg)
    if arg.startswith('-fmodule-map-file='): cmd += ['-Xcc', arg]
cmd += ['-Xcc', '-fmodule-map-file='+str(core/'ExpoModulesCore.modulemap')]
with (out/'compile.log').open('w') as log:
    subprocess.run(cmd + [str(src) for src in sources], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
fixture = module/'tests/nearby-policy-fixtures.swift'
subprocess.run(['xcrun', 'swiftc', str(module/'ios/NearbyLease.swift'), str(fixture), '-o', str(out/'policy-fixtures')], check=True, timeout=60)
result = subprocess.check_output([str(out/'policy-fixtures')], text=True, timeout=10)
assert result.strip() == '4 Swift nearby policy fixtures passed'
(out/'policy.log').write_text(result)
(out/'evidence.json').write_text(json.dumps({'policyTests':4, 'expoBridgeCompiled':True, 'physicalDevice':False,
    'sdk':sdk, 'sourceSha256':{str(src.relative_to(module)):hashlib.sha256(src.read_bytes()).hexdigest() for src in [*sources,fixture]}}, indent=2)+'\n')
print('Swift nearby fixtures passed:', out/'evidence.json')
