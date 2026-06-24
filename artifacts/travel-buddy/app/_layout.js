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
exports.default = RootLayout;
var react_1 = require("react");
var expo_router_1 = require("expo-router");
var expo_status_bar_1 = require("expo-status-bar");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var react_native_gesture_handler_1 = require("react-native-gesture-handler");
var react_native_1 = require("react-native");
var Notifications = require("expo-notifications");
var AttachmentStore_1 = require("../src/context/AttachmentStore");
var AttachController_1 = require("../src/components/AttachController");
var PlanPickerController_1 = require("../src/components/PlanPickerController");
var AvailabilityStore_1 = require("../src/context/AvailabilityStore");
var SessionContext_1 = require("../src/context/SessionContext");
var LocationContext_1 = require("../src/context/LocationContext");
var LanguagePreferenceContext_1 = require("../src/context/LanguagePreferenceContext");
var usePushToken_1 = require("../src/hooks/usePushToken");
var tokens_1 = require("../src/theme/tokens");
var NotificationToast_1 = require("../src/components/NotificationToast");
// Notify handler: show banner even when app is foregrounded
if (react_native_1.Platform.OS !== 'web') {
    Notifications.setNotificationHandler({
        handleNotification: function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, ({
                        shouldShowBanner: true,
                        shouldPlaySound: true,
                        shouldSetBadge: false,
                        shouldShowList: true,
                    })];
            });
        }); },
    });
}
function PushSetup() {
    (0, usePushToken_1.usePushToken)();
    (0, react_1.useEffect)(function () {
        if (react_native_1.Platform.OS === 'web')
            return;
        var sub = Notifications.addNotificationResponseReceivedListener(function (response) {
            var data = response.notification.request.content.data;
            if (!data)
                return;
            if (data.screen === 'availability' && typeof data.tripId === 'string') {
                expo_router_1.router.push({ pathname: '/trip/[id]', params: { id: data.tripId } });
            }
            else if (data.screen === 'meetup' && typeof data.meetupId === 'string') {
                expo_router_1.router.push("/meetup/".concat(data.meetupId));
            }
        });
        return function () { return sub.remove(); };
    }, []);
    return null;
}
function RootLayout() {
    return (<react_native_gesture_handler_1.GestureHandlerRootView style={{ flex: 1 }}>
      <react_native_safe_area_context_1.SafeAreaProvider>
        <SessionContext_1.SessionProvider>
          <LanguagePreferenceContext_1.LanguagePreferenceProvider>
          <LocationContext_1.LocationProvider>
            <AvailabilityStore_1.AvailabilityProvider>
              <AttachmentStore_1.AttachmentProvider>
                <AttachController_1.AttachControllerProvider>
                  <PlanPickerController_1.PlanPickerControllerProvider>
                    <NotificationToast_1.NotificationToastProvider>
                      <PushSetup />
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
                    </NotificationToast_1.NotificationToastProvider>
                  </PlanPickerController_1.PlanPickerControllerProvider>
                </AttachController_1.AttachControllerProvider>
              </AttachmentStore_1.AttachmentProvider>
            </AvailabilityStore_1.AvailabilityProvider>
          </LocationContext_1.LocationProvider>
          </LanguagePreferenceContext_1.LanguagePreferenceProvider>
        </SessionContext_1.SessionProvider>
      </react_native_safe_area_context_1.SafeAreaProvider>
    </react_native_gesture_handler_1.GestureHandlerRootView>);
}
