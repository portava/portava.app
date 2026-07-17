const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Block Metro from watching reanimated's temp android build directories
// (they are created and deleted during install, causing ENOENT crashes)
// Also block Jest test files that live under app/ so Expo Router does not
// try to turn them into routes in the dev/production bundles.
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  /node_modules.*react-native-reanimated_tmp.*/,
  /node_modules.*_tmp_\d+/,
  /\/__tests__\/.*/,
  /\.(component\.)?test\.(tsx|ts|jsx|js)$/,
];

// On web, redirect native-only packages to no-op shims so TurboModuleRegistry
// calls don't throw "Cannot read properties of undefined (reading 'getEnforcing')".
const WEB_SHIMS = {
  "react-native-view-shot": path.resolve(
    __dirname,
    "src/shims/react-native-view-shot.web.js"
  ),
  "react-native-share": path.resolve(
    __dirname,
    "src/shims/react-native-share.web.js"
  ),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && WEB_SHIMS[moduleName]) {
    return { filePath: WEB_SHIMS[moduleName], type: "sourceFile" };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
