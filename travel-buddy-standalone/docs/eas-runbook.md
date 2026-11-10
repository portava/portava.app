# iPhone install runbook

This guide covers two different ways to install Portava on an iPhone:

- **Personal Team (free Apple ID):** a local build from Xcode on your Mac for
  your own, connected iPhone. No EAS cloud build is involved. The app signing
  expires after seven days, so rebuild and reinstall it weekly.
- **EAS internal distribution:** a cloud build using an `eas.json` profile,
  such as `development` or `preview`. This has its own EAS signing and device
  distribution setup; it is not the free Personal Team flow described below.

## Local iPhone build with a Personal Team

### Before you start

- A Mac with Xcode installed and opened at least once.
- This repository checked out on the Mac, with the standalone app dependencies
  installed (`pnpm install` from `travel-buddy-standalone/`).
- Your iPhone and the cable needed to connect it to the Mac.
- An Apple ID. A paid Apple Developer Program membership is not required for
  this personal-device build.

### Add your Apple ID and prepare the iPhone

1. Open Xcode and go to **Xcode → Settings → Accounts** (called **Preferences**
   in older Xcode versions).
2. Click **+**, choose **Apple Account**, and sign in with the Apple ID you will
   use to sign the app. Xcode will show its **Personal Team**.
3. Connect and unlock the iPhone. If it asks whether to trust this computer,
   tap **Trust** on the iPhone and enter its passcode. In Xcode, open
   **Window → Devices and Simulators** and wait for the phone to finish pairing.
4. On iOS 16 and later, if the phone asks for Developer Mode, enable it under
   **Settings → Privacy & Security → Developer Mode** and restart the phone.

### Generate, sign, and run the app

Run these commands from the app directory on the Mac:

```bash
cd travel-buddy-standalone
PORTAVA_PERSONAL_TEAM=1 npx expo prebuild --platform ios
open ios/Portava.xcworkspace
```

In Xcode:

1. Select the **Portava** project, then its **Portava** app target.
2. Open **Signing & Capabilities** and leave **Automatically manage signing**
   enabled.
3. Choose your **Personal Team** in the **Team** menu. If Xcode asks to register
   the connected phone or create a provisioning profile, allow it.
4. Select your connected iPhone as the run destination, then click **Run** (▶).
   Xcode builds the app, installs it, and launches it on the phone.
5. If iOS blocks the first launch because the developer is not trusted, open
   **Settings → General → VPN & Device Management**, select the developer entry
   for your Apple ID, and tap **Trust**.

The `PORTAVA_PERSONAL_TEAM=1` setting is important when generating or
regenerating the iOS project. It removes capabilities that a free Personal Team
cannot sign:

- Sign in with Apple is unavailable in this build.
- Push notifications are unavailable.
- Universal links are not enabled; web links open the website instead.

Do not set this variable for EAS builds. It is intended only for local
Personal Team builds.

## Renewing the free provisioning

The free Personal Team provisioning profile expires after **seven days**. When
it expires, the installed app can no longer be opened. Repeat the generate,
sign, and run steps above from the Mac, selecting the same iPhone and Personal
Team. Xcode creates a fresh profile and installs a renewed build. Repeat this
at least once every seven days to keep the app usable.

## EAS internal distribution is a separate path

The EAS profiles in `eas.json` are for cloud builds, for example:

```bash
npx eas build --profile development --platform ios
```

EAS builds on its build service and uses EAS's configured signing credentials
and internal-distribution setup. Use this path for an EAS development or
preview build, rather than setting `PORTAVA_PERSONAL_TEAM=1`. A Personal Team
build is produced locally by Xcode, signed with the Apple ID added to Xcode, and
intended only for the owner's connected iPhone; it is not a substitute for an
EAS build distributed to testers.
