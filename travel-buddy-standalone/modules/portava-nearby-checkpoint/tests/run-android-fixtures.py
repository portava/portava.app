#!/usr/bin/env python3
"""Compile copied production nearby code and test only an explicitly selected emulator.
No SDK install, license changes, real credentials, production traffic or flags.
"""
import argparse, hashlib, json, os, re, shutil, subprocess
from pathlib import Path
import xml.etree.ElementTree as ET
p = argparse.ArgumentParser(description=__doc__)
for name in ('output','sdk','java-home','gradle','gradle-cache','serial'):
    p.add_argument('--'+name, required=True)
p.add_argument('--adb-server-port', default='5037')
a = p.parse_args()
if not re.fullmatch(r'emulator-\d+', a.serial): p.error('an emulator serial is required')
module = Path(__file__).resolve().parent.parent
out = Path(a.output).resolve()
if out.exists() or out.is_relative_to(module): p.error('output must be a new directory outside source')
out.mkdir(parents=True)
hashes = {}
for src in (module/'android/src').rglob('*.kt'):
    if src.name == 'PortavaNearbyCheckpointModule.kt': continue
    dest = out/'src'/src.relative_to(module/'android/src')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src,dest)
    hashes[str(src.relative_to(module))] = hashlib.sha256(dest.read_bytes()).hexdigest()
(out/'settings.gradle').write_text("pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { google(); mavenCentral() } }\nrootProject.name='PortavaNearbyFixtures'\n")
deps = (module/'android/build.gradle').read_text().split('dependencies {',1)[1]
(out/'build.gradle').write_text("""plugins { id 'com.android.application' version '8.11.0'; id 'org.jetbrains.kotlin.android' version '2.1.20' }
android {
 namespace 'com.portava.maps.nearby.fixtures'
 compileSdk 36
 defaultConfig { applicationId 'com.portava.maps.nearby.fixtures'; minSdk 24; targetSdk 36; testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner' }
 compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = '17' }
 sourceSets { main { manifest.srcFile 'AndroidManifest.xml' } }
}
dependencies {"""+deps)
manifest = (module/'android/src/main/AndroidManifest.xml').read_text().replace('</manifest>', '<application android:label="Portava Nearby Fixtures" /></manifest>')
(out/'AndroidManifest.xml').write_text(manifest)
(out/'gradle.properties').write_text('android.useAndroidX=true\norg.gradle.jvmargs=-Xmx1536m\n')
(out/'local.properties').write_text('sdk.dir='+a.sdk+'\n')
env = {**os.environ, 'JAVA_HOME':a.java_home,'ANDROID_HOME':a.sdk,'GRADLE_USER_HOME':a.gradle_cache,'ANDROID_ADB_SERVER_PORT':a.adb_server_port}
with (out/'build.log').open('w') as log:
    subprocess.run([a.gradle,'-p',str(out),'testDebugUnitTest','assembleDebug','assembleDebugAndroidTest','--no-daemon','--max-workers=2'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=900)
suites = [ET.parse(f).getroot() for f in (out/'build/test-results/testDebugUnitTest').glob('TEST-*.xml')]
assert sum(int(s.attrib['tests']) for s in suites)==4
assert all(int(s.attrib['failures'])==0 and int(s.attrib['errors'])==0 for s in suites)
adb = [str(Path(a.sdk)/'platform-tools/adb'),'-s',a.serial]
assert subprocess.check_output([*adb,'shell','getprop','sys.boot_completed'],env=env,text=True,timeout=15).strip()=='1'
for kind in ('debug','androidTest/debug'):
    apks = list((out/'build/outputs/apk'/kind).glob('*.apk')); assert len(apks)==1
    subprocess.run([*adb,'install','-r',str(apks[0])],env=env,check=True,timeout=60)
run = subprocess.run([*adb,'shell','am','instrument','-w','-r','com.portava.maps.nearby.fixtures.test/androidx.test.runner.AndroidJUnitRunner'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=True,timeout=240)
(out/'device-tests.log').write_text(run.stdout)
assert re.search(r'OK \(3 tests\)',run.stdout), 'See device-tests.log'
(out/'evidence.json').write_text(json.dumps({'policyTests':4,'deviceTests':3,'physicalDevice':False,'expoBridgeIncluded':False,'serial':a.serial,'sourceSha256':hashes},indent=2)+'\n')
print('Android nearby fixtures passed:',out/'evidence.json')
