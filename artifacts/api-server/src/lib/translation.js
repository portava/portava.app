"use strict";
/**
 * Translation provider abstraction.
 *
 * Interface + MockTranslationProvider (dev/test) + OpenAITranslationProvider.
 * Provider selection via env vars:
 *   TRANSLATION_PROVIDER        — 'mock' (default) | 'openai'
 *   TRANSLATION_ENABLED         — 'true' | 'false' (default 'true')
 *   TRANSLATION_TIMEOUT_MS      — number (default 8000)
 *
 * NEVER log full message body. Only log message_id, status, source/target, provider, error code.
 */
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
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAITranslationProvider = exports.MockTranslationProvider = exports.TRANSLATION_TIMEOUT_MS = exports.TRANSLATION_ENABLED = void 0;
exports.getTranslationProvider = getTranslationProvider;
exports.languageDisplayName = languageDisplayName;
exports.validateTranslation = validateTranslation;
exports._setTranslationProvider = _setTranslationProvider;
exports._clearTranslationProvider = _clearTranslationProvider;
var openai_1 = require("./openai");
// ── Config ────────────────────────────────────────────────────────────────────
exports.TRANSLATION_ENABLED = ((_a = process.env.TRANSLATION_ENABLED) !== null && _a !== void 0 ? _a : 'true').toLowerCase() !== 'false';
exports.TRANSLATION_TIMEOUT_MS = Number((_b = process.env.TRANSLATION_TIMEOUT_MS) !== null && _b !== void 0 ? _b : 5000);
// ── Mock provider ─────────────────────────────────────────────────────────────
var MOCK_LANGUAGE_MAP = {
    'hola': 'es', 'bonjour': 'fr', 'ciao': 'it', 'hallo': 'de',
    'こんにちは': 'ja', '안녕': 'ko', '你好': 'zh', 'olá': 'pt',
    'привет': 'ru', 'مرحبا': 'ar', 'สวัสดี': 'th',
};
var MockTranslationProvider = /** @class */ (function () {
    function MockTranslationProvider() {
    }
    MockTranslationProvider.prototype.detectLanguage = function (text) {
        return __awaiter(this, void 0, void 0, function () {
            var lower, _i, _a, _b, word, lang;
            return __generator(this, function (_c) {
                lower = text.toLowerCase();
                for (_i = 0, _a = Object.entries(MOCK_LANGUAGE_MAP); _i < _a.length; _i++) {
                    _b = _a[_i], word = _b[0], lang = _b[1];
                    if (lower.includes(word))
                        return [2 /*return*/, { language: lang, confidence: 'low' }];
                }
                return [2 /*return*/, { language: 'en', confidence: 'low' }];
            });
        });
    };
    MockTranslationProvider.prototype.translateText = function (text, source, target) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, {
                        translatedText: "[translated from ".concat(source, "] ").concat(text),
                        provider: 'mock',
                    }];
            });
        });
    };
    return MockTranslationProvider;
}());
exports.MockTranslationProvider = MockTranslationProvider;
// ── OpenAI provider ───────────────────────────────────────────────────────────
var ISO_LANGUAGE_NAMES = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', pt: 'Portuguese', it: 'Italian', ru: 'Russian',
    ar: 'Arabic', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tl: 'Filipino',
    sv: 'Swedish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', hi: 'Hindi',
};
var OpenAITranslationProvider = /** @class */ (function () {
    function OpenAITranslationProvider() {
    }
    OpenAITranslationProvider.prototype.detectLanguage = function (text) {
        return __awaiter(this, void 0, void 0, function () {
            var snippet, completion, raw, parsed;
            var _a, _b, _c, _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        snippet = text.slice(0, 200);
                        return [4 /*yield*/, openai_1.openai.chat.completions.create({
                                model: 'gpt-4o-mini',
                                messages: [
                                    {
                                        role: 'system',
                                        content: 'You are a language detection utility. Respond with ONLY a JSON object: {"language":"<ISO 639-1 code>","confidence":"high"|"low"}. No other text.',
                                    },
                                    { role: 'user', content: snippet },
                                ],
                                max_tokens: 20,
                                temperature: 0,
                            })];
                    case 1:
                        completion = _f.sent();
                        raw = (_d = (_c = (_b = (_a = completion.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.trim()) !== null && _d !== void 0 ? _d : '{}';
                        try {
                            parsed = JSON.parse(raw);
                            return [2 /*return*/, {
                                    language: (_e = parsed.language) !== null && _e !== void 0 ? _e : 'en',
                                    confidence: parsed.confidence === 'high' ? 'high' : 'low',
                                }];
                        }
                        catch (_g) {
                            return [2 /*return*/, { language: 'en', confidence: 'low' }];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    OpenAITranslationProvider.prototype.translateText = function (text, source, target) {
        return __awaiter(this, void 0, void 0, function () {
            var targetName, completion, translated;
            var _a, _b, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        targetName = (_a = ISO_LANGUAGE_NAMES[target]) !== null && _a !== void 0 ? _a : target;
                        return [4 /*yield*/, openai_1.openai.chat.completions.create({
                                model: 'gpt-4o-mini',
                                messages: [
                                    {
                                        role: 'system',
                                        content: "Translate the following message to ".concat(targetName, ". Respond with ONLY the translated text, preserving tone and emoji. Do not add explanations."),
                                    },
                                    { role: 'user', content: text },
                                ],
                                max_tokens: 1000,
                                temperature: 0.3,
                            })];
                    case 1:
                        completion = _e.sent();
                        translated = (_d = (_c = (_b = completion.choices[0]) === null || _b === void 0 ? void 0 : _b.message) === null || _c === void 0 ? void 0 : _c.content) === null || _d === void 0 ? void 0 : _d.trim();
                        if (!translated)
                            throw new Error('empty_response');
                        return [2 /*return*/, { translatedText: translated, provider: 'openai' }];
                }
            });
        });
    };
    return OpenAITranslationProvider;
}());
exports.OpenAITranslationProvider = OpenAITranslationProvider;
// ── Provider factory ──────────────────────────────────────────────────────────
var _provider = null;
function getTranslationProvider() {
    var _a;
    if (_provider)
        return _provider;
    var name = ((_a = process.env.TRANSLATION_PROVIDER) !== null && _a !== void 0 ? _a : 'mock').toLowerCase();
    if (name === 'openai') {
        _provider = new OpenAITranslationProvider();
    }
    else {
        _provider = new MockTranslationProvider();
    }
    return _provider;
}
/** ISO 639-1 → display name (e.g. 'es' → 'Spanish') */
function languageDisplayName(iso) {
    var _a;
    return (_a = ISO_LANGUAGE_NAMES[iso]) !== null && _a !== void 0 ? _a : iso.toUpperCase();
}
/**
 * Sentence-terminal punctuation set (covers Latin, CJK, ellipsis).
 * A translation whose original ends with terminal punctuation but whose
 * translation does not is considered potentially truncated.
 */
var SENTENCE_TERMINAL_RE = /[.!?。！？…]$/u;
/**
 * validateTranslation — returns whether a translation result is safe to show.
 *
 * Rules (in order):
 *  1. Non-empty / non-whitespace
 *  2. At least 20% the character length of the original
 *  3. Not character-identical to the original (no-op translation)
 *  4. If original ends with sentence-terminal punctuation, translation must too
 *     (guards against mid-sentence truncation)
 *
 * Privacy: callers must never log the original or translated text themselves.
 */
function validateTranslation(original, translated) {
    var origTrimmed = original.trim();
    var transTrimmed = translated.trim();
    if (!transTrimmed) {
        return { valid: false, reason: 'empty' };
    }
    if (origTrimmed.length > 0 && transTrimmed.length < origTrimmed.length * 0.2) {
        return { valid: false, reason: 'too_short' };
    }
    if (transTrimmed === origTrimmed) {
        return { valid: false, reason: 'identical' };
    }
    if (SENTENCE_TERMINAL_RE.test(origTrimmed) && !SENTENCE_TERMINAL_RE.test(transTrimmed)) {
        return { valid: false, reason: 'truncated' };
    }
    return { valid: true };
}
/** For unit tests — inject a custom provider. */
function _setTranslationProvider(p) {
    _provider = p;
}
function _clearTranslationProvider() {
    _provider = null;
}
