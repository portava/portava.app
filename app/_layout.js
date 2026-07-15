"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = RootLayout;
var expo_router_1 = require("expo-router");
var expo_status_bar_1 = require("expo-status-bar");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var react_native_gesture_handler_1 = require("react-native-gesture-handler");
var AttachmentStore_1 = require("../src/context/AttachmentStore");
var AttachController_1 = require("../src/components/AttachController");
var AvailabilityStore_1 = require("../src/context/AvailabilityStore");
var SessionContext_1 = require("../src/context/SessionContext");
var tokens_1 = require("../src/theme/tokens");
function RootLayout() {
    return (<react_native_gesture_handler_1.GestureHandlerRootView style={{ flex: 1 }}>
      <react_native_safe_area_context_1.SafeAreaProvider>
        <SessionContext_1.SessionProvider>
          <AvailabilityStore_1.AvailabilityProvider>
            <AttachmentStore_1.AttachmentProvider>
              <AttachController_1.AttachControllerProvider>
                <expo_status_bar_1.StatusBar style="dark"/>
                <expo_router_1.Stack screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: tokens_1.color.paper },
            animation: 'slide_from_right',
        }}>
                  <expo_router_1.Stack.Screen name="(tabs)"/>
                  <expo_router_1.Stack.Screen name="(auth)"/>
                  <expo_router_1.Stack.Screen name="create" options={{ presentation: 'modal' }}/>
                  <expo_router_1.Stack.Screen name="notifications" options={{ presentation: 'modal' }}/>
                </expo_router_1.Stack>
              </AttachController_1.AttachControllerProvider>
            </AttachmentStore_1.AttachmentProvider>
          </AvailabilityStore_1.AvailabilityProvider>
        </SessionContext_1.SessionProvider>
      </react_native_safe_area_context_1.SafeAreaProvider>
    </react_native_gesture_handler_1.GestureHandlerRootView>);
}
