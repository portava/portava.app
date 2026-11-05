#!/usr/bin/env python3
"""Build the actual Android core and exercise codecs in an explicitly selected emulator.

Requires an already installed/licensed SDK, JDK, Gradle and FFmpeg. Does not
install SDK packages, accept licenses, modify app dependencies or enable flags.
The Expo bridge is compiled separately in an isolated Expo native project.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("output", "sdk", "java-home", "gradle", "ffmpeg", "serial"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--gradle-cache")
    parser.add_argument("--adb-server-port", default="5037")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        parser.error("select an emulator explicitly; this harness does not install on physical devices")
    module = Path(__file__).resolve().parent.parent
    output = Path(args.output).resolve()
    if output.exists() or output.is_relative_to(module):
        parser.error("output must be a new directory outside the source module")
    sdk = Path(args.sdk).resolve()
    if not (sdk / "platforms/android-36/android.jar").is_file():
        parser.error("an installed Android 36 SDK is required")
    for name in ("gradle", "ffmpeg"):
        if not Path(getattr(args, name)).is_absolute():
            parser.error(name + " must be an absolute trusted executable path")
    output.mkdir(parents=True)
    sources = module / "android/src"
    copied = {}
    for source in sources.rglob("*.kt"):
        if source.name == "PortavaVideoCompressorModule.kt":
            continue
        destination = output / "src" / source.relative_to(sources)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied[str(source.relative_to(module))] = hashlib.sha256(destination.read_bytes()).hexdigest()
    (output / "settings.gradle").write_text("""pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name='PortavaCompressionFixtures'
""")
    # Reuse the real module's exact Media3 and test dependency declarations.
    dependency_block = (module / "android/build.gradle").read_text().split("dependencies {", 1)[1]
    (output / "build.gradle").write_text("""plugins {
 id 'com.android.application' version '8.11.0'
 id 'org.jetbrains.kotlin.android' version '2.1.20'
}
android {
 namespace 'com.portava.media.compression.fixtures'
 compileSdk 36
 defaultConfig { applicationId 'com.portava.media.compression.fixtures'; minSdk 24; targetSdk 36; testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner' }
 compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = '17' }
 sourceSets { main { manifest.srcFile 'AndroidManifest.xml' } }
}
dependencies {""" + dependency_block)
    (output / "gradle.properties").write_text("android.useAndroidX=true\norg.gradle.jvmargs=-Xmx1536m\n")
    (output / "local.properties").write_text("sdk.dir=" + str(sdk).replace("\\", "\\\\").replace(":", "\\:") + "\n")
    (output / "AndroidManifest.xml").write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Portava Media Fixtures" /></manifest>\n')
    assets = output / "src/androidTest/assets"
    assets.mkdir(parents=True, exist_ok=True)
    def encode(arguments):
        subprocess.run([args.ffmpeg, "-nostdin", "-v", "error", "-y", *arguments], check=True, timeout=60)
    encode(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "3", "-c:v", "libx264", "-crf", "12", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-metadata", "location=+37.0000-122.0000/", str(assets / "source.mp4")])
    encode(["-display_rotation", "90", "-i", str(assets / "source.mp4"), "-c", "copy", str(assets / "portrait.mov")])
    encode(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-c:v", "libx264", "-crf", "10",
            "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", str(assets / "silent.mp4")])
    env = {**os.environ, "JAVA_HOME": str(Path(args.java_home).resolve()), "ANDROID_HOME": str(sdk),
           "GRADLE_USER_HOME": str(Path(args.gradle_cache).resolve() if args.gradle_cache else output / "gradle-cache"),
           "ANDROID_ADB_SERVER_PORT": args.adb_server_port}
    with (output / "build.log").open("w") as log:
        subprocess.run([args.gradle, "-p", str(output), "testDebugUnitTest", "assembleDebugAndroidTest", "assembleDebug",
                        "--no-daemon", "--max-workers=2"], env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
    reports = list((output / "build/test-results/testDebugUnitTest").glob("TEST-*.xml"))
    suites = [ET.parse(report).getroot() for report in reports]
    assert sum(int(suite.attrib["tests"]) for suite in suites) == 5, "all five native policy tests must execute"
    assert all(int(suite.attrib["errors"]) == 0 and int(suite.attrib["failures"]) == 0 and int(suite.attrib.get("skipped", "0")) == 0 for suite in suites)
    adb = [str(sdk / "platform-tools/adb"), "-s", args.serial]
    assert subprocess.check_output([*adb, "shell", "getprop", "sys.boot_completed"], env=env, text=True, timeout=15).strip() == "1"
    for kind in ("debug", "androidTest/debug"):
        apks = list((output / "build/outputs/apk" / kind).glob("*.apk"))
        assert len(apks) == 1
        subprocess.run([*adb, "install", "-r", str(apks[0])], env=env, check=True, timeout=60)
    run = subprocess.run([*adb, "shell", "am", "instrument", "-w", "-r",
                          "com.portava.media.compression.fixtures.test/androidx.test.runner.AndroidJUnitRunner"],
                         env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=600)
    (output / "device-tests.log").write_text(run.stdout)
    assert re.search(r"OK \(3 tests\)", run.stdout), "all three actual-codec tests must pass; see device-tests.log"
    (output / "evidence.json").write_text(json.dumps({"policyTests": 5, "codecTests": 3, "serial": args.serial,
                                                   "sourceSha256": copied, "physicalDevice": False, "expoBridgeIncluded": False}, indent=2) + "\n")
    print("Native policy and Android codec tests passed. Evidence:", output / "evidence.json")


if __name__ == "__main__":
    main()
