"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
var pino_1 = require("pino");
var isProduction = process.env.NODE_ENV === "production";
exports.logger = (0, pino_1.default)(__assign({ level: (_a = process.env.LOG_LEVEL) !== null && _a !== void 0 ? _a : "info", redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
    ] }, (isProduction
    ? {}
    : {
        transport: {
            target: "pino-pretty",
            options: { colorize: true },
        },
    })));
