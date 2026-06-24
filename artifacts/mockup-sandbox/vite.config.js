"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var vite_1 = require("vite");
var plugin_react_1 = require("@vitejs/plugin-react");
var vite_2 = require("@tailwindcss/vite");
var path_1 = require("path");
var vite_plugin_runtime_error_modal_1 = require("@replit/vite-plugin-runtime-error-modal");
var mockupPreviewPlugin_1 = require("./mockupPreviewPlugin");
var rawPort = process.env.PORT;
if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
}
var port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
    throw new Error("Invalid PORT value: \"".concat(rawPort, "\""));
}
var basePath = process.env.BASE_PATH;
if (!basePath) {
    throw new Error("BASE_PATH environment variable is required but was not provided.");
}
exports.default = (0, vite_1.defineConfig)({
    base: basePath,
    plugins: __spreadArray([
        (0, mockupPreviewPlugin_1.mockupPreviewPlugin)(),
        (0, plugin_react_1.default)(),
        (0, vite_2.default)(),
        (0, vite_plugin_runtime_error_modal_1.default)()
    ], (process.env.NODE_ENV !== "production" &&
        process.env.REPL_ID !== undefined
        ? [
            await Promise.resolve().then(function () { return require("@replit/vite-plugin-cartographer"); }).then(function (m) {
                return m.cartographer({
                    root: path_1.default.resolve(import.meta.dirname, ".."),
                });
            }),
        ]
        : []), true),
    resolve: {
        alias: {
            "@": path_1.default.resolve(import.meta.dirname, "src"),
        },
    },
    root: path_1.default.resolve(import.meta.dirname),
    build: {
        outDir: path_1.default.resolve(import.meta.dirname, "dist"),
        emptyOutDir: true,
    },
    server: {
        port: port,
        host: "0.0.0.0",
        allowedHosts: true,
        fs: {
            strict: true,
        },
    },
    preview: {
        port: port,
        host: "0.0.0.0",
        allowedHosts: true,
    },
});
