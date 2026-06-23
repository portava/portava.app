"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openai = void 0;
var openai_1 = require("openai");
var baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
var apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
if (!baseURL || !apiKey) {
    console.warn("[telegraph] OpenAI integration env vars not set — recommendations will be unavailable");
}
exports.openai = new openai_1.default({
    baseURL: baseURL !== null && baseURL !== void 0 ? baseURL : "https://api.openai.com/v1",
    apiKey: apiKey !== null && apiKey !== void 0 ? apiKey : "not-configured",
});
