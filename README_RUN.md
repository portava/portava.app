# Travel Buddy — run on your Mac

## One-time setup
Open Terminal, cd into this folder, then:

    npm install

(takes 1-2 min, downloads dependencies)

## Run it

    npx expo start

Then:
- press **w** to open in your Mac browser, OR
- scan the QR code with your iPhone (phone + Mac on same WiFi) to open in Expo Go

That's it. No tunnel, no ngrok — local WiFi just works.

## If web complains about missing packages
    npx expo install react-dom react-native-web @expo/metro-runtime
    npx expo start
