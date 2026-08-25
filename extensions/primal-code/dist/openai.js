"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOpenAiModels = listOpenAiModels;
exports.streamOpenAi = streamOpenAi;
const vscode = __importStar(require("vscode"));
const openai_messages_1 = require("./openai-messages");
/**
 * OpenAI Chat Completions backend: model discovery plus a streaming request
 * that emits VS Code response parts.
 *
 * Tool-call arguments stream as fragments spread over many deltas, keyed by an
 * index rather than an id, so they are accumulated per index and only parsed
 * once the stream ends — a fragment is not valid JSON on its own.
 */
const BASE = "https://api.openai.com/v1";
/** Titlecase an id for the picker: "gpt-5.5" -> "GPT-5.5". */
function displayName(id) {
    return id.startsWith("gpt-") ? `GPT-${id.slice(4)}` : id.toUpperCase();
}
/**
 * Ask the account which models it can actually use, rather than shipping a
 * hardcoded list that goes stale and offers models the user cannot call.
 */
async function listOpenAiModels(key, base = BASE) {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok)
        throw new Error(await describeFailure(res));
    const body = (await res.json());
    const ids = (body.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
    return (0, openai_messages_1.selectChatModels)(ids).map((id) => ({
        id,
        name: displayName(id),
        // The endpoint does not report context windows, and guessing per-model
        // would go stale; these are conservative floors for current chat models.
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
    }));
}
/**
 * Run one streaming completion, reporting parts as they arrive. `base` selects
 * the OpenAI-compatible endpoint — every non-Anthropic provider (Gemini,
 * DeepSeek, Kimi, GLM, MiniMax) speaks this same protocol on its own host.
 */
async function streamOpenAi(key, model, messages, tools, maxOutputTokens, progress, signal, base = BASE) {
    const converted = (0, openai_messages_1.toOpenAiTools)(tools);
    const body = {
        model,
        messages: (0, openai_messages_1.toOpenAiMessages)(messages),
        stream: true,
        max_completion_tokens: maxOutputTokens,
    };
    if (converted.length > 0)
        body.tools = converted;
    const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok || !res.body)
        throw new Error(await describeFailure(res));
    const reader = res.body.getReader();
    // stream: true so a multi-byte character split across chunks is not mangled.
    const decoder = new TextDecoder();
    let buffer = "";
    // Keyed by the delta's index: OpenAI identifies a streaming tool call by
    // position, and only the FIRST fragment carries the id and name.
    const pending = new Map();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
                for (const line of frame.split("\n")) {
                    if (!line.startsWith("data:"))
                        continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === "[DONE]")
                        continue;
                    let chunk;
                    try {
                        chunk = JSON.parse(payload);
                    }
                    catch {
                        continue; // one malformed frame must not kill the response
                    }
                    if (chunk.error?.message)
                        throw new Error(chunk.error.message);
                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta)
                        continue;
                    if (delta.content)
                        progress.report(new vscode.LanguageModelTextPart(delta.content));
                    for (const call of delta.tool_calls ?? []) {
                        const index = call.index ?? 0;
                        const existing = pending.get(index) ?? { id: "", name: "", args: "" };
                        pending.set(index, {
                            id: call.id ?? existing.id,
                            name: call.function?.name ?? existing.name,
                            args: existing.args + (call.function?.arguments ?? ""),
                        });
                    }
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    // Tool calls only complete when the stream does: there is no per-call stop
    // event, so they are emitted here.
    for (const call of pending.values()) {
        if (!call.name)
            continue;
        let input = {};
        try {
            // A tool taking no arguments streams "" or "{}", which is not an error.
            input = call.args.trim() ? JSON.parse(call.args) : {};
        }
        catch {
            input = {};
        }
        progress.report(new vscode.LanguageModelToolCallPart(call.id || `call_${call.name}`, call.name, input));
    }
}
/** Turn an API failure into something a user can act on. */
async function describeFailure(res) {
    if (res.status === 401)
        return "Your OpenAI key was rejected. Run “Primal: Set OpenAI API key” to replace it.";
    if (res.status === 403)
        return "That OpenAI key isn't allowed to use this model.";
    if (res.status === 429) {
        return "OpenAI rate-limited this key, or the account is out of credit. Check your billing at platform.openai.com.";
    }
    try {
        const detail = (await res.json());
        if (detail.error?.message)
            return detail.error.message;
    }
    catch {
        // fall through
    }
    return `OpenAI request failed (${res.status})`;
}
//# sourceMappingURL=openai.js.map