"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorFallback = ErrorFallback;
var vector_icons_1 = require("@expo/vector-icons");
var expo_1 = require("expo");
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var useColors_1 = require("@/hooks/useColors");
function ErrorFallback(_a) {
    var _this = this;
    var error = _a.error, resetError = _a.resetError;
    var colors = (0, useColors_1.useColors)();
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _b = (0, react_1.useState)(false), isModalVisible = _b[0], setIsModalVisible = _b[1];
    var handleRestart = function () { return __awaiter(_this, void 0, void 0, function () {
        var restartError_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, expo_1.reloadAppAsync)()];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    restartError_1 = _a.sent();
                    console.error("Failed to restart app:", restartError_1);
                    resetError();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    var formatErrorDetails = function () {
        var details = "Error: ".concat(error.message, "\n\n");
        if (error.stack) {
            details += "Stack Trace:\n".concat(error.stack);
        }
        return details;
    };
    var monoFont = react_native_1.Platform.select({
        ios: "Menlo",
        android: "monospace",
        default: "monospace",
    });
    return (<react_native_1.View style={[styles.container, { backgroundColor: colors.background }]}>
      {__DEV__ ? (<react_native_1.Pressable onPress={function () { return setIsModalVisible(true); }} accessibilityLabel="View error details" accessibilityRole="button" style={function (_a) {
                var pressed = _a.pressed;
                return [
                    styles.topButton,
                    {
                        top: insets.top + 16,
                        backgroundColor: colors.card,
                        opacity: pressed ? 0.8 : 1,
                    },
                ];
            }}>
          <vector_icons_1.Feather name="alert-circle" size={20} color={colors.foreground}/>
        </react_native_1.Pressable>) : null}

      <react_native_1.View style={styles.content}>
        <react_native_1.Text style={[styles.title, { color: colors.foreground }]}>
          Something went wrong
        </react_native_1.Text>

        <react_native_1.Text style={[styles.message, { color: colors.mutedForeground }]}>
          Please reload the app to continue.
        </react_native_1.Text>

        <react_native_1.Pressable onPress={handleRestart} style={function (_a) {
            var pressed = _a.pressed;
            return [
                styles.button,
                {
                    backgroundColor: colors.primary,
                    opacity: pressed ? 0.9 : 1,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                },
            ];
        }}>
          <react_native_1.Text style={[
            styles.buttonText,
            { color: colors.primaryForeground },
        ]}>
            Try Again
          </react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {__DEV__ ? (<react_native_1.Modal visible={isModalVisible} animationType="slide" transparent={true} onRequestClose={function () { return setIsModalVisible(false); }}>
          <react_native_1.View style={styles.modalOverlay}>
            <react_native_1.View style={[
                styles.modalContainer,
                { backgroundColor: colors.background },
            ]}>
              <react_native_1.View style={[
                styles.modalHeader,
                { borderBottomColor: colors.border },
            ]}>
                <react_native_1.Text style={[styles.modalTitle, { color: colors.foreground }]}>
                  Error Details
                </react_native_1.Text>
                <react_native_1.Pressable onPress={function () { return setIsModalVisible(false); }} accessibilityLabel="Close error details" accessibilityRole="button" style={function (_a) {
                var pressed = _a.pressed;
                return [
                    styles.closeButton,
                    { opacity: pressed ? 0.6 : 1 },
                ];
            }}>
                  <vector_icons_1.Feather name="x" size={24} color={colors.foreground}/>
                </react_native_1.Pressable>
              </react_native_1.View>

              <react_native_1.ScrollView style={styles.modalScrollView} contentContainerStyle={[
                styles.modalScrollContent,
                { paddingBottom: insets.bottom + 16 },
            ]} showsVerticalScrollIndicator>
                <react_native_1.View style={[
                styles.errorContainer,
                { backgroundColor: colors.card },
            ]}>
                  <react_native_1.Text style={[
                styles.errorText,
                {
                    color: colors.foreground,
                    fontFamily: monoFont,
                },
            ]} selectable>
                    {formatErrorDetails()}
                  </react_native_1.Text>
                </react_native_1.View>
              </react_native_1.ScrollView>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.Modal>) : null}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
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
        maxWidth: 600,
    },
    title: {
        fontSize: 28,
        fontWeight: "700",
        textAlign: "center",
        lineHeight: 40,
    },
    message: {
        fontSize: 16,
        textAlign: "center",
        lineHeight: 24,
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
        paddingVertical: 16,
        borderRadius: 8,
        paddingHorizontal: 24,
        minWidth: 200,
        shadowColor: "#000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    buttonText: {
        fontWeight: "600",
        textAlign: "center",
        fontSize: 16,
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
