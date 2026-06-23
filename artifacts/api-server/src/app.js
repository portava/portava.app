"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var cors_1 = require("cors");
var pino_http_1 = require("pino-http");
var routes_1 = require("./routes");
var logger_1 = require("./lib/logger");
var app = (0, express_1.default)();
app.use((0, pino_http_1.default)({
    logger: logger_1.logger,
    serializers: {
        req: function (req) {
            var _a;
            return {
                id: req.id,
                method: req.method,
                url: (_a = req.url) === null || _a === void 0 ? void 0 : _a.split("?")[0],
            };
        },
        res: function (res) {
            return {
                statusCode: res.statusCode,
            };
        },
    },
}));
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use("/api", routes_1.default);
exports.default = app;
