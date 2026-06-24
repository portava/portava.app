"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = NotFoundScreen;
var expo_router_1 = require("expo-router");
var react_native_1 = require("react-native");
var useColors_1 = require("@/hooks/useColors");
function NotFoundScreen() {
    var colors = (0, useColors_1.useColors)();
    return (<>
      <expo_router_1.Stack.Screen options={{ title: "Oops!" }}/>
      <react_native_1.View style={[styles.container, { backgroundColor: colors.background }]}>
        <react_native_1.Text style={[styles.title, { color: colors.foreground }]}>
          This screen doesn&apos;t exist.
        </react_native_1.Text>

        <expo_router_1.Link href="/" style={styles.link}>
          <react_native_1.Text style={[styles.linkText, { color: colors.primary }]}>
            Go to home screen!
          </react_native_1.Text>
        </expo_router_1.Link>
      </react_native_1.View>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
    },
    title: {
        fontSize: 20,
        fontWeight: "bold",
    },
    link: {
        marginTop: 15,
        paddingVertical: 15,
    },
    linkText: {
        fontSize: 14,
    },
});
