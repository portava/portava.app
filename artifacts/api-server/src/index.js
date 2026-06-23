"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var app_1 = require("./app");
var logger_1 = require("./lib/logger");
var dailyBriefCleanup_1 = require("./lib/dailyBriefCleanup");
var weatherCacheCleanup_1 = require("./lib/weatherCacheCleanup");
var rawPort = process.env["PORT"];
if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
}
var port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
    throw new Error("Invalid PORT value: \"".concat(rawPort, "\""));
}
app_1.default.listen(port, function (err) {
    if (err) {
        logger_1.logger.error({ err: err }, "Error listening on port");
        process.exit(1);
    }
    logger_1.logger.info({ port: port }, "Server listening");
    (0, dailyBriefCleanup_1.startDailyBriefCleanup)();
    (0, weatherCacheCleanup_1.startWeatherCacheCleanup)();
    // Startup health check — warn if the cleanup job hasn't run recently.
    // Queries the persistent job_health table so the check is accurate across
    // server restarts (not just for the current process lifecycle).
    (0, dailyBriefCleanup_1.queryCleanupHealth)().then(function (_a) {
        var cleanupStatus = _a.cleanupStatus, lastRunAt = _a.lastRunAt;
        if (cleanupStatus === "critical") {
            logger_1.logger.error({ lastRunAt: lastRunAt }, "startup: cleanup job is critically overdue — check job_health table");
        }
        else if (cleanupStatus === "overdue") {
            logger_1.logger.warn({ lastRunAt: lastRunAt }, "startup: cleanup job has not run within the expected window — check job_health table");
        }
    }).catch(function (startupErr) {
        logger_1.logger.warn({ err: startupErr }, "startup: could not query cleanup job health");
    });
});
