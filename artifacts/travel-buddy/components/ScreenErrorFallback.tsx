import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import type { ErrorFallbackProps } from "@/components/ErrorFallback";

/**
 * Per-screen error fallback — shown when a single screen's ErrorBoundary
 * catches a crash. Unlike the root ErrorFallback, this does NOT reload the
 * whole app. The tab bar and navigation remain functional; the user can tap
 * "Try Again" to remount only this screen or "Go back" to navigate away.
 */
export function ScreenErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [isModalVisible, setIsModalVisible] = useState(false);

  const monoFont = Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  });

  const formatErrorDetails = (): string => {
    let details = `Error: ${error.message}\n\n`;
    if (error.stack) {
      details += `Stack Trace:\n${error.stack}`;
    }
    return details;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {__DEV__ ? (
        <Pressable
          onPress={() => setIsModalVisible(true)}
          accessibilityLabel="View error details"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.topButton,
            {
              top: insets.top + 16,
              backgroundColor: colors.card,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Feather name="alert-circle" size={20} color={colors.foreground} />
        </Pressable>
      ) : null}

      <View style={styles.content}>
        <Feather name="alert-triangle" size={40} color={colors.mutedForeground} />

        <Text style={[styles.title, { color: colors.foreground }]}>
          This screen ran into a problem
        </Text>

        <Text style={[styles.message, { color: colors.mutedForeground }]}>
          You can try again or go back. The rest of the app is still working.
        </Text>

        <Pressable
          onPress={resetError}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.9 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
            Try Again
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.buttonSecondary,
            {
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Text style={[styles.buttonSecondaryText, { color: colors.foreground }]}>
            Go Back
          </Text>
        </Pressable>
      </View>

      {__DEV__ ? (
        <Modal
          visible={isModalVisible}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setIsModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View
              style={[
                styles.modalContainer,
                { backgroundColor: colors.background },
              ]}
            >
              <View
                style={[
                  styles.modalHeader,
                  { borderBottomColor: colors.border },
                ]}
              >
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                  Error Details
                </Text>
                <Pressable
                  onPress={() => setIsModalVisible(false)}
                  accessibilityLabel="Close error details"
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.closeButton,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Feather name="x" size={24} color={colors.foreground} />
                </Pressable>
              </View>
              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={[
                  styles.modalScrollContent,
                  { paddingBottom: insets.bottom + 16 },
                ]}
                showsVerticalScrollIndicator
              >
                <View
                  style={[
                    styles.errorContainer,
                    { backgroundColor: colors.card },
                  ]}
                >
                  <Text
                    style={[
                      styles.errorText,
                      { color: colors.foreground, fontFamily: monoFont },
                    ]}
                    selectable
                  >
                    {formatErrorDetails()}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    width: "100%",
    maxWidth: 400,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 32,
  },
  message: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  topButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 8,
    paddingHorizontal: 24,
    minWidth: 200,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    fontWeight: "600",
    textAlign: "center",
    fontSize: 16,
  },
  buttonSecondary: {
    paddingVertical: 12,
    borderRadius: 8,
    paddingHorizontal: 24,
    minWidth: 200,
    borderWidth: 1,
  },
  buttonSecondaryText: {
    fontWeight: "500",
    textAlign: "center",
    fontSize: 15,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    width: "100%",
    height: "90%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
  },
  errorContainer: {
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
    padding: 16,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 18,
    width: "100%",
  },
});
