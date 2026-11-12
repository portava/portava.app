#!/usr/bin/env python3
"""Stage the installed op-sqlite engine and synthetic Android test in /tmp only.
No package install, shared dependency mutation, or app prebuild is performed.
"""
from pathlib import Path
import argparse, shutil
parser=argparse.ArgumentParser()
parser.add_argument('source_package', type=Path)
parser.add_argument('destination', type=Path)
args=parser.parse_args()
source=args.source_package.resolve(); dest=args.destination.resolve()
if not dest.is_relative_to(Path('/tmp').resolve()): raise SystemExit('Validation copy must be under /tmp')
if source==dest: raise SystemExit('Source and destination must differ')
shutil.copytree(source,dest,dirs_exist_ok=True,ignore=shutil.ignore_patterns('build','.cxx','.gradle'))
android=dest/'android'; here=Path(__file__).resolve().parent
shutil.copy(here/'sqlcipher-smoke.cpp',android/'sqlcipher-smoke.cpp')
test=android/'src/androidTest/java/com/portava/telegraph/validation';test.mkdir(parents=True,exist_ok=True)
shutil.copy(here/'CipherEngineTest.kt',test/'CipherEngineTest.kt')
p=android/'CMakeLists.txt';p.write_text(p.read_text()+'''\n# Isolated validation only; never shipped.\nadd_library(portava-sqlcipher-smoke SHARED sqlcipher-smoke.cpp)\ntarget_link_libraries(portava-sqlcipher-smoke op-sqlite)\n''')
p=android/'build.gradle';text=p.read_text().replace('android {','android {\n  ndkVersion rootProject.ext.ndkVersion',1).replace('  defaultConfig {','  defaultConfig {\n    testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',1)
# The published library excludes React libraries because the app supplies them.
# A standalone instrumentation APK must package its matching runtime itself.
for library in ['libjsi.so','libreact_nativemodule_core.so','libturbomodulejsijni.so','libc++_shared.so','libfbjni.so','libreactnative.so']:
 text=text.replace('        "**/'+library+'",\n','')
text+='''\ndependencies {\n androidTestImplementation "androidx.test:runner:1.6.2"\n androidTestImplementation "androidx.test.ext:junit:1.2.1"\n}\nandroid.packagingOptions.jniLibs.pickFirsts += ["**/libc++_shared.so", "**/libfbjni.so", "**/libreactnative.so", "**/libjsi.so"]\n'''
p.write_text(text)
print(dest)
