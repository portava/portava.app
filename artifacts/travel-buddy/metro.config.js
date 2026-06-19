const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Block Metro from watching reanimated's temp android build directories
// (they are created and deleted during install, causing ENOENT crashes)
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  /node_modules.*react-native-reanimated_tmp.*/,
];

module.exports = config;
