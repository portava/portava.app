/**
 * withPortavaNSE — Expo config plugin for the Portava iOS Notification
 * Service Extension.
 *
 * CURRENT STATE: intentional pass-through stub.
 *
 * app.json references "./plugins/withPortavaNSE". Until this file
 * existed, every EAS build failed at config resolution with
 * "Failed to resolve plugin for module ./plugins/withPortavaNSE".
 * This stub makes the reference valid so builds can proceed.
 *
 * WHY A STUB IS CORRECT RIGHT NOW:
 * The NSE exists to decrypt E2EE push-notification envelopes on-device
 * (design doc §3.4, Phase E-5). Phase E-5 is not implemented yet —
 * the current push pipeline still sends readable payloads, so there is
 * nothing for an extension to decrypt. Creating the Xcode target now
 * would add native surface area with zero function.
 *
 * WHEN PHASE E-5 LANDS, replace this stub with a real plugin that:
 *   1. Adds an NSE target (e.g. "PortavaNotificationService") to the
 *      Xcode project via withXcodeProject.
 *   2. Sets the extension's bundle id to
 *      `${config.ios.bundleIdentifier}.NotificationService`.
 *   3. Adds NSExtension attributes to the extension Info.plist
 *      (NSExtensionPointIdentifier: com.apple.usernotifications.service).
 *   4. Adds App Group + Keychain Sharing entitlements shared with the
 *      main app so the extension can read the push-decryption key from
 *      the shared Keychain access group.
 *   5. Registers the Swift handler file that decrypts the envelope and
 *      rewrites the notification content, with the graceful fallback
 *      ("New message", no content) on any failure.
 * Community references for that work: expo-notification-service-extension-plugin,
 * @config-plugins packages that use withXcodeProject to add targets.
 *
 * Until then: config in, config out, untouched.
 */

const withPortavaNSE = (config) => {
  // Pass-through. Reserved for Phase E-5 (encrypted push envelopes).
  return config;
};

module.exports = withPortavaNSE;
