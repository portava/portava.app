"use strict";
/**
 * MessageTranslationService
 *
 * Runs after a message is saved. For each recipient in the thread:
 *   (a) Detects source language (provider first, then sender preference fallback).
 *   (b) Looks up recipient's preferred_message_language.
 *   (c) Skips if languages match (status: skipped).
 *   (d) Calls provider with timeout + max 2 retries.
 *   (e) Writes / updates a message_translations row.
 *   (f) Falls back to status: failed on any error — never throws.
 *
 * Privacy: never logs full message body. Only message_id, status, codes.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateMessageForThread = translateMessageForThread;
exports.retranslateForUser = retranslateForUser;
exports.markTranslationsPending = markTranslationsPending;
exports.buildDisplayFields = buildDisplayFields;
var translation_1 = require("../lib/translation");
var telegraphEvents_1 = require("../lib/telegraphEvents");
// ── Helpers ───────────────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
    return __awaiter(this, void 0, void 0, function () {
        var timer, timeout;
        return __generator(this, function (_a) {
            timeout = new Promise(function (_, reject) {
                timer = setTimeout(function () { return reject(new Error('translation_timeout')); }, ms);
            });
            return [2 /*return*/, Promise.race([promise, timeout]).finally(function () { return clearTimeout(timer); })];
        });
    });
}
function detectWithRetry(text, maxRetries) {
    return __awaiter(this, void 0, void 0, function () {
        var provider, lastErr, attempt, result, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    provider = (0, translation_1.getTranslationProvider)();
                    attempt = 0;
                    _a.label = 1;
                case 1:
                    if (!(attempt <= maxRetries)) return [3 /*break*/, 6];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, withTimeout(provider.detectLanguage(text), translation_1.TRANSLATION_TIMEOUT_MS)];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, result.language];
                case 4:
                    e_1 = _a.sent();
                    lastErr = e_1;
                    return [3 /*break*/, 5];
                case 5:
                    attempt++;
                    return [3 /*break*/, 1];
                case 6: throw lastErr;
            }
        });
    });
}
function translateWithRetry(text, source, target, maxRetries) {
    return __awaiter(this, void 0, void 0, function () {
        var prov, lastErr, attempt, e_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    prov = (0, translation_1.getTranslationProvider)();
                    attempt = 0;
                    _a.label = 1;
                case 1:
                    if (!(attempt <= maxRetries)) return [3 /*break*/, 6];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, withTimeout(prov.translateText(text, source, target), translation_1.TRANSLATION_TIMEOUT_MS)];
                case 3: return [2 /*return*/, _a.sent()];
                case 4:
                    e_2 = _a.sent();
                    lastErr = e_2;
                    return [3 /*break*/, 5];
                case 5:
                    attempt++;
                    return [3 /*break*/, 1];
                case 6: throw lastErr;
            }
        });
    });
}
/**
 * translateMessageForThread
 *
 * Call this after a message row is inserted. Never throws — all errors are
 * caught and written as status: 'failed' rows. Returns resolved promise always.
 */
function translateMessageForThread(sc, input) {
    return __awaiter(this, void 0, void 0, function () {
        var messageId, body, senderId, threadId, senderPreferredLanguage, logger, members, recipientIds, sourceLanguage, detectionSource, _a, profiles, profileMap, _i, _b, p, explicitLang, legacyLang, _c, recipientIds_1, recipientId, prefs, targetLanguage, result, validation, e_3, errCode, e_4, code;
        var _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    messageId = input.messageId, body = input.body, senderId = input.senderId, threadId = input.threadId, senderPreferredLanguage = input.senderPreferredLanguage, logger = input.logger;
                    if (!translation_1.TRANSLATION_ENABLED)
                        return [2 /*return*/];
                    _h.label = 1;
                case 1:
                    _h.trys.push([1, 22, , 23]);
                    return [4 /*yield*/, sc
                            .from('message_thread_members')
                            .select('user_id')
                            .eq('thread_id', threadId)
                            .neq('user_id', senderId)];
                case 2:
                    members = (_h.sent()).data;
                    recipientIds = (members !== null && members !== void 0 ? members : []).map(function (m) { return m.user_id; });
                    if (recipientIds.length === 0)
                        return [2 /*return*/];
                    sourceLanguage = void 0;
                    detectionSource = void 0;
                    _h.label = 3;
                case 3:
                    _h.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, detectWithRetry(body, 1)];
                case 4:
                    sourceLanguage = _h.sent();
                    detectionSource = 'provider';
                    return [3 /*break*/, 6];
                case 5:
                    _a = _h.sent();
                    sourceLanguage = senderPreferredLanguage !== null && senderPreferredLanguage !== void 0 ? senderPreferredLanguage : 'en';
                    detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';
                    return [3 /*break*/, 6];
                case 6: 
                // Update the message with detected language.
                return [4 /*yield*/, sc
                        .from('messages')
                        .update({ original_language: sourceLanguage, language_detection_source: detectionSource })
                        .eq('id', messageId)];
                case 7:
                    // Update the message with detected language.
                    _h.sent();
                    return [4 /*yield*/, sc
                            .from('profiles')
                            .select('id, preferred_language, preferred_message_language, auto_translate_messages')
                            .in('id', recipientIds)];
                case 8:
                    profiles = (_h.sent()).data;
                    profileMap = {};
                    for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                        p = _b[_i];
                        explicitLang = p.preferred_language;
                        legacyLang = p.preferred_message_language;
                        profileMap[p.id] = {
                            preferredLanguage: (_d = explicitLang !== null && explicitLang !== void 0 ? explicitLang : legacyLang) !== null && _d !== void 0 ? _d : 'en',
                            autoTranslate: (_e = p.auto_translate_messages) !== null && _e !== void 0 ? _e : true,
                        };
                    }
                    _c = 0, recipientIds_1 = recipientIds;
                    _h.label = 9;
                case 9:
                    if (!(_c < recipientIds_1.length)) return [3 /*break*/, 21];
                    recipientId = recipientIds_1[_c];
                    prefs = (_f = profileMap[recipientId]) !== null && _f !== void 0 ? _f : { preferredLanguage: 'en', autoTranslate: true };
                    targetLanguage = prefs.preferredLanguage;
                    if (!!prefs.autoTranslate) return [3 /*break*/, 11];
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: recipientId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: targetLanguage,
                            translatedBody: null,
                            provider: null,
                            status: 'skipped',
                            errorMessage: 'auto_translate_disabled',
                        })];
                case 10:
                    _h.sent();
                    return [3 /*break*/, 20];
                case 11:
                    if (!(sourceLanguage === targetLanguage)) return [3 /*break*/, 13];
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: recipientId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: targetLanguage,
                            translatedBody: null,
                            provider: null,
                            status: 'skipped',
                            errorMessage: null,
                        })];
                case 12:
                    _h.sent();
                    return [3 /*break*/, 20];
                case 13:
                    _h.trys.push([13, 18, , 20]);
                    return [4 /*yield*/, translateWithRetry(body, sourceLanguage, targetLanguage, 1)];
                case 14:
                    result = _h.sent();
                    validation = (0, translation_1.validateTranslation)(body, result.translatedText);
                    if (!!validation.valid) return [3 /*break*/, 16];
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: recipientId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: targetLanguage,
                            translatedBody: null,
                            provider: result.provider,
                            status: 'failed',
                            errorMessage: "validation_".concat((_g = validation.reason) !== null && _g !== void 0 ? _g : 'unknown'),
                        })];
                case 15:
                    _h.sent();
                    logger === null || logger === void 0 ? void 0 : logger.warn({
                        messageId: messageId,
                        recipientId: recipientId,
                        source: sourceLanguage,
                        target: targetLanguage,
                        provider: result.provider,
                        reason: validation.reason,
                    }, 'translation_validation_failed');
                    return [3 /*break*/, 20];
                case 16: return [4 /*yield*/, upsertTranslation(sc, {
                        messageId: messageId,
                        recipientId: recipientId,
                        sourceLanguage: sourceLanguage,
                        targetLanguage: targetLanguage,
                        translatedBody: result.translatedText,
                        provider: result.provider,
                        status: 'translated',
                        errorMessage: null,
                    })];
                case 17:
                    _h.sent();
                    logger === null || logger === void 0 ? void 0 : logger.info({ messageId: messageId, recipientId: recipientId, source: sourceLanguage, target: targetLanguage, provider: result.provider }, 'translation_ok');
                    // Realtime: the translated text can now swap in live for this recipient.
                    (0, telegraphEvents_1.publishToUsers)([recipientId], {
                        type: 'message.translated',
                        threadId: threadId,
                        payload: { messageId: messageId, status: 'translated' },
                    });
                    return [3 /*break*/, 20];
                case 18:
                    e_3 = _h.sent();
                    errCode = e_3 instanceof Error ? (e_3.message.length < 80 ? e_3.message : 'translation_error') : 'unknown';
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: recipientId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: targetLanguage,
                            translatedBody: null,
                            provider: null,
                            status: 'failed',
                            errorMessage: errCode,
                        })];
                case 19:
                    _h.sent();
                    logger === null || logger === void 0 ? void 0 : logger.warn({ messageId: messageId, recipientId: recipientId, source: sourceLanguage, target: targetLanguage, err: errCode }, 'translation_failed');
                    return [3 /*break*/, 20];
                case 20:
                    _c++;
                    return [3 /*break*/, 9];
                case 21: return [3 /*break*/, 23];
                case 22:
                    e_4 = _h.sent();
                    code = e_4 instanceof Error ? e_4.message : 'pipeline_error';
                    logger === null || logger === void 0 ? void 0 : logger.error({ messageId: messageId, err: code }, 'translation_pipeline_error');
                    return [3 /*break*/, 23];
                case 23: return [2 /*return*/];
            }
        });
    });
}
// ── Retranslate on language-preference change ─────────────────────────────────
var RETRANSLATE_BATCH_LIMIT = 200;
/**
 * retranslateForUser — fire-and-forget sweep triggered when a user changes
 * their preferred translation language.
 *
 * Fetches the user's most-recent message_translations rows (as recipient),
 * then re-translates each one to the new target language.  Only this user's
 * rows are touched; other recipients are unaffected.  Never throws.
 */
function retranslateForUser(sc, userId, newTargetLanguage, logger) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, rows, fetchErr, messageIds, _b, messages, msgErr, msgMap, _i, _c, m, srcMap, _d, rows_1, r, _e, messageIds_1, messageId, msg, sourceLanguage, result, validation, e_5, errCode, e_6, code;
        var _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    if (!translation_1.TRANSLATION_ENABLED)
                        return [2 /*return*/];
                    _j.label = 1;
                case 1:
                    _j.trys.push([1, 15, , 16]);
                    return [4 /*yield*/, sc
                            .from('message_translations')
                            .select('message_id, source_language')
                            .eq('recipient_id', userId)
                            .order('updated_at', { ascending: false })
                            .limit(RETRANSLATE_BATCH_LIMIT)];
                case 2:
                    _a = _j.sent(), rows = _a.data, fetchErr = _a.error;
                    if (fetchErr) {
                        logger === null || logger === void 0 ? void 0 : logger.warn({ err: fetchErr.message, userId: userId }, 'retranslate_fetch_failed');
                        return [2 /*return*/];
                    }
                    if (!rows || rows.length === 0)
                        return [2 /*return*/];
                    messageIds = rows.map(function (r) { return r.message_id; });
                    return [4 /*yield*/, sc
                            .from('messages')
                            .select('id, body, original_language')
                            .in('id', messageIds)];
                case 3:
                    _b = _j.sent(), messages = _b.data, msgErr = _b.error;
                    if (msgErr) {
                        logger === null || logger === void 0 ? void 0 : logger.warn({ err: msgErr.message, userId: userId }, 'retranslate_messages_fetch_failed');
                        return [2 /*return*/];
                    }
                    msgMap = {};
                    for (_i = 0, _c = messages !== null && messages !== void 0 ? messages : []; _i < _c.length; _i++) {
                        m = _c[_i];
                        msgMap[m.id] = {
                            body: m.body,
                            originalLanguage: m.original_language,
                        };
                    }
                    srcMap = {};
                    for (_d = 0, rows_1 = rows; _d < rows_1.length; _d++) {
                        r = rows_1[_d];
                        srcMap[r.message_id] = r.source_language;
                    }
                    _e = 0, messageIds_1 = messageIds;
                    _j.label = 4;
                case 4:
                    if (!(_e < messageIds_1.length)) return [3 /*break*/, 14];
                    messageId = messageIds_1[_e];
                    msg = msgMap[messageId];
                    if (!msg || !msg.body)
                        return [3 /*break*/, 13];
                    sourceLanguage = (_g = (_f = msg.originalLanguage) !== null && _f !== void 0 ? _f : srcMap[messageId]) !== null && _g !== void 0 ? _g : 'en';
                    if (!(sourceLanguage === newTargetLanguage)) return [3 /*break*/, 6];
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: userId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: newTargetLanguage,
                            translatedBody: null,
                            provider: null,
                            status: 'skipped',
                            errorMessage: null,
                        })];
                case 5:
                    _j.sent();
                    return [3 /*break*/, 13];
                case 6:
                    _j.trys.push([6, 11, , 13]);
                    return [4 /*yield*/, translateWithRetry(msg.body, sourceLanguage, newTargetLanguage, 1)];
                case 7:
                    result = _j.sent();
                    validation = (0, translation_1.validateTranslation)(msg.body, result.translatedText);
                    if (!!validation.valid) return [3 /*break*/, 9];
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: userId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: newTargetLanguage,
                            translatedBody: null,
                            provider: result.provider,
                            status: 'failed',
                            errorMessage: "validation_".concat((_h = validation.reason) !== null && _h !== void 0 ? _h : 'unknown'),
                        })];
                case 8:
                    _j.sent();
                    return [3 /*break*/, 13];
                case 9: return [4 /*yield*/, upsertTranslation(sc, {
                        messageId: messageId,
                        recipientId: userId,
                        sourceLanguage: sourceLanguage,
                        targetLanguage: newTargetLanguage,
                        translatedBody: result.translatedText,
                        provider: result.provider,
                        status: 'translated',
                        errorMessage: null,
                    })];
                case 10:
                    _j.sent();
                    return [3 /*break*/, 13];
                case 11:
                    e_5 = _j.sent();
                    errCode = e_5 instanceof Error ? (e_5.message.length < 80 ? e_5.message : 'translation_error') : 'unknown';
                    return [4 /*yield*/, upsertTranslation(sc, {
                            messageId: messageId,
                            recipientId: userId,
                            sourceLanguage: sourceLanguage,
                            targetLanguage: newTargetLanguage,
                            translatedBody: null,
                            provider: null,
                            status: 'failed',
                            errorMessage: errCode,
                        })];
                case 12:
                    _j.sent();
                    logger === null || logger === void 0 ? void 0 : logger.warn({ messageId: messageId, userId: userId, target: newTargetLanguage, err: errCode }, 'retranslate_item_failed');
                    return [3 /*break*/, 13];
                case 13:
                    _e++;
                    return [3 /*break*/, 4];
                case 14:
                    logger === null || logger === void 0 ? void 0 : logger.info({ userId: userId, target: newTargetLanguage, count: messageIds.length }, 'retranslate_sweep_complete');
                    return [3 /*break*/, 16];
                case 15:
                    e_6 = _j.sent();
                    code = e_6 instanceof Error ? e_6.message : 'retranslate_error';
                    logger === null || logger === void 0 ? void 0 : logger.error({ userId: userId, err: code }, 'retranslate_sweep_error');
                    return [3 /*break*/, 16];
                case 16: return [2 /*return*/];
            }
        });
    });
}
// ── Invalidate (on edit) ──────────────────────────────────────────────────────
/**
 * markTranslationsPending — called when a message is edited.
 * Sets all existing message_translations rows for this message to 'pending'
 * so the pipeline regenerates them.
 */
function markTranslationsPending(sc, messageId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, sc
                        .from('message_translations')
                        .update({ status: 'pending', translated_body: null, error_message: null })
                        .eq('message_id', messageId)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// ── Display field builder (for GET /messages) ─────────────────────────────────
/**
 * Build per-message display fields for the requesting user (as recipient).
 * `myUserId` is the current authenticated user.
 * `translationRow` is their message_translations row (or null).
 */
function buildDisplayFields(msg, myUserId, translationRow) {
    var _a, _b;
    // Deleted messages: no body, no translation.
    if (msg.deleted || msg.body === null) {
        return {
            displayBody: null,
            originalBody: null,
            originalLanguage: null,
            translated: false,
            translationStatus: null,
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    // Sender sees their own message — always original, no label.
    if (msg.senderId === myUserId) {
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: (_a = msg.originalLanguage) !== null && _a !== void 0 ? _a : null,
            translated: false,
            translationStatus: null,
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    // No translation row (same language or pipeline not run yet).
    if (!translationRow) {
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: (_b = msg.originalLanguage) !== null && _b !== void 0 ? _b : null,
            translated: false,
            translationStatus: null,
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    var status = translationRow.status, translated_body = translationRow.translated_body, source_language = translationRow.source_language;
    if (status === 'skipped') {
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: source_language,
            translated: false,
            translationStatus: 'skipped',
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    if (status === 'pending') {
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: source_language,
            translated: false,
            translationStatus: 'pending',
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    if (status === 'failed') {
        // Silent fallback: show original text with no label or error banner.
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: source_language,
            translated: false,
            translationStatus: 'failed',
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    // status === 'translated'
    // Guard against an identical translation slipping through (no-op).
    var translatedText = translated_body !== null && translated_body !== void 0 ? translated_body : null;
    if (!translatedText || translatedText.trim() === msg.body.trim()) {
        return {
            displayBody: msg.body,
            originalBody: msg.body,
            originalLanguage: source_language,
            translated: false,
            translationStatus: 'translated',
            translationLabel: null,
            canShowOriginal: false,
        };
    }
    var sourceName = (0, translation_1.languageDisplayName)(source_language);
    return {
        displayBody: translatedText,
        originalBody: msg.body,
        originalLanguage: source_language,
        translated: true,
        translationStatus: 'translated',
        translationLabel: "Translated from ".concat(sourceName),
        canShowOriginal: true,
    };
}
// ── Upsert helper ─────────────────────────────────────────────────────────────
function upsertTranslation(sc, row) {
    return __awaiter(this, void 0, void 0, function () {
        var now;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    now = new Date().toISOString();
                    return [4 /*yield*/, sc.from('message_translations').upsert({
                            message_id: row.messageId,
                            recipient_id: row.recipientId,
                            source_language: row.sourceLanguage,
                            target_language: row.targetLanguage,
                            translated_body: row.translatedBody,
                            provider: row.provider,
                            status: row.status,
                            error_message: row.errorMessage,
                            updated_at: now,
                        }, { onConflict: 'message_id,recipient_id' })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
