import UserNotifications

/**
 * PortavaNSE — Notification Service Extension (E-0 scaffold).
 *
 * Phase E-0: empty forwarder — passes the notification through unchanged.
 * Phase E-5 (deferred): will decrypt E2EE push payloads here before display.
 *
 * The NSE runs in a separate process with ~30s budget and limited memory.
 * It has access to the same App Group container as the main app, so it can
 * read the per-thread MLS group state from the shared keychain group.
 *
 * IMPORTANT: This file lives in the PortavaNSE extension target, NOT the main app target.
 * It is compiled separately. Do not import Expo or React Native here.
 */
class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        // E-0: forward unchanged.
        // TODO (E-5): if bestAttemptContent?.userInfo["e2ee"] == true,
        //   load group state from shared Keychain group,
        //   decrypt ciphertext field,
        //   set bestAttemptContent?.body = decryptedText
        contentHandler(bestAttemptContent ?? request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        // Called with ~5s left in budget; deliver best-effort content.
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }
}
