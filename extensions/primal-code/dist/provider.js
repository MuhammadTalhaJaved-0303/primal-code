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
exports.PrimalChatProvider = void 0;
const vscode = __importStar(require("vscode"));
const messages_1 = require("./messages");
const openai_1 = require("./openai");
/**
 * Registers the user's own models as first-class VS Code language models.
 *
 * This is the whole bet: rather than building a chat panel, a diff viewer, a
 * tool-approval UI and an editor, we hand VS Code a model and it uses its own.
 * Agent mode, inline chat, tool calling, file editing and every extension the
 * user already has come for free, and the key never leaves their machine.
 *
 * Models from every configured provider appear in one picker. A model's id is
 * namespaced ("openai:gpt-5.5") so the response handler knows where to send it
 * without a second lookup.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic publishes no model-list endpoint, so these are curated. */
const CLAUDE_MODELS = [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", maxInputTokens: 200_000, maxOutputTokens: 32_000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", maxInputTokens: 200_000, maxOutputTokens: 64_000 },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", maxInputTokens: 200_000, maxOutputTokens: 32_000 },
];
/**
 * Every provider besides Anthropic speaks the OpenAI protocol on its own host.
 * OpenAI itself keeps its dynamic /models discovery; the others ship curated
 * lists because their /models responses are inconsistent about which entries
 * are chat-capable.
 */
const OPENAI_COMPAT = {
    google: {
        base: "https://generativelanguage.googleapis.com/v1beta/openai",
        family: "Gemini",
        imageInput: true,
        models: [
            { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", maxInputTokens: 1_000_000, maxOutputTokens: 65_000 },
            { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", maxInputTokens: 1_000_000, maxOutputTokens: 65_000 },
        ],
    },
    deepseek: {
        base: "https://api.deepseek.com/v1",
        family: "DeepSeek",
        models: [
            { id: "deepseek-chat", name: "DeepSeek Chat", maxInputTokens: 128_000, maxOutputTokens: 8_000 },
            { id: "deepseek-reasoner", name: "DeepSeek Reasoner", maxInputTokens: 128_000, maxOutputTokens: 64_000 },
        ],
    },
    kimi: {
        base: "https://api.moonshot.ai/v1",
        family: "Kimi",
        models: [
            { id: "kimi-k2-0905-preview", name: "Kimi K2", maxInputTokens: 256_000, maxOutputTokens: 32_000 },
            { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", maxInputTokens: 256_000, maxOutputTokens: 32_000 },
        ],
    },
    glm: {
        base: "https://open.bigmodel.cn/api/paas/v4",
        family: "GLM",
        models: [
            { id: "glm-4.6", name: "GLM-4.6", maxInputTokens: 200_000, maxOutputTokens: 96_000 },
            { id: "glm-4.5-air", name: "GLM-4.5 Air", maxInputTokens: 128_000, maxOutputTokens: 96_000 },
        ],
    },
    minimax: {
        base: "https://api.minimax.io/v1",
        family: "MiniMax",
        models: [
            { id: "MiniMax-M2", name: "MiniMax M2", maxInputTokens: 200_000, maxOutputTokens: 32_000 },
        ],
    },
};
const namespaced = (provider, id) => `${provider}:${id}`;
function splitId(value) {
    const at = value.indexOf(":");
    if (at === -1)
        return { provider: "anthropic", model: value };
    return { provider: value.slice(0, at), model: value.slice(at + 1) };
}
class PrimalChatProvider {
    secrets;
    changed = new vscode.EventEmitter();
    onDidChangeLanguageModelChatInformation = this.changed.event;
    constructor(secrets) {
        this.secrets = secrets;
    }
    /** Call after any key changes so VS Code re-queries the model list. */
    refresh() {
        this.changed.fire();
    }
    async provideLanguageModelChatInformation(_options, _token) {
        const models = [];
        const anthropicKey = await this.secrets.get("anthropic");
        if (anthropicKey) {
            for (const model of CLAUDE_MODELS) {
                models.push(this.describe("anthropic", model, "Claude"));
            }
        }
        const openaiKey = await this.secrets.get("openai");
        if (openaiKey) {
            try {
                for (const model of await (0, openai_1.listOpenAiModels)(openaiKey)) {
                    models.push(this.describe("openai", model, "GPT"));
                }
            }
            catch {
                // A bad or rate-limited key must not blank out the other provider's
                // models; the failure surfaces properly on the first request instead.
            }
        }
        for (const [providerId, compat] of Object.entries(OPENAI_COMPAT)) {
            const key = await this.secrets.get(providerId);
            if (!key)
                continue;
            for (const model of compat.models) {
                models.push(this.describe(providerId, model, compat.family, compat.imageInput));
            }
        }
        return models;
    }
    describe(provider, model, family, imageInput) {
        return {
            id: namespaced(provider, model.id),
            name: model.name,
            family,
            version: model.id,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: Math.min(model.maxOutputTokens, readMaxOutputTokens()),
            tooltip: "Runs on your own API key. Primal never sees your code.",
            detail: "Primal Code · BYOK",
            capabilities: { toolCalling: true, imageInput: imageInput ?? provider === "anthropic" },
        };
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const { provider, model: modelId } = splitId(model.id);
        const key = await this.secrets.get(provider);
        if (!key)
            throw new Error(`No ${provider} key. Run “Primal: Set API key”.`);
        // Cancellation has to reach the socket, not just stop the loop: otherwise a
        // cancelled request keeps generating and the user keeps paying for it.
        const abort = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abort.abort());
        try {
            if (provider === "anthropic") {
                await this.streamAnthropic(key, modelId, messages, options, model.maxOutputTokens, progress, abort.signal);
            }
            else {
                // openai and every OpenAI-compatible provider (Gemini, DeepSeek,
                // Kimi, GLM, MiniMax) share one streaming client; only the host differs.
                const base = OPENAI_COMPAT[provider]?.base;
                await (0, openai_1.streamOpenAi)(key, modelId, messages, options.tools, model.maxOutputTokens, progress, abort.signal, base);
            }
        }
        catch (error) {
            // An abort is the user's own doing, not a failure to report.
            if (abort.signal.aborted)
                return;
            throw error instanceof Error ? error : new Error(String(error));
        }
        finally {
            cancelSub.dispose();
        }
    }
    async streamAnthropic(key, modelId, messages, options, maxOutputTokens, progress, signal) {
        const tools = (0, messages_1.toAnthropicTools)(options.tools);
        const body = {
            model: modelId,
            max_tokens: maxOutputTokens,
            messages: (0, messages_1.toAnthropicMessages)(messages),
            stream: true,
        };
        if (tools.length > 0)
            body.tools = tools;
        const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": key,
                "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok || !res.body)
            throw new Error(await describeAnthropicFailure(res));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const pendingTools = new Map();
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
                        let event;
                        try {
                            event = JSON.parse(payload);
                        }
                        catch {
                            continue;
                        }
                        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                            pendingTools.set(event.index ?? 0, {
                                id: event.content_block.id ?? "",
                                name: event.content_block.name ?? "",
                                json: "",
                            });
                        }
                        else if (event.type === "content_block_delta") {
                            if (event.delta?.type === "text_delta" && event.delta.text) {
                                progress.report(new vscode.LanguageModelTextPart(event.delta.text));
                            }
                            else if (event.delta?.type === "input_json_delta") {
                                const pending = pendingTools.get(event.index ?? 0);
                                if (pending)
                                    pending.json += event.delta.partial_json ?? "";
                            }
                        }
                        else if (event.type === "content_block_stop") {
                            const pending = pendingTools.get(event.index ?? 0);
                            if (pending) {
                                pendingTools.delete(event.index ?? 0);
                                // A tool with no arguments streams no deltas at all, so an
                                // empty accumulator means `{}`, not malformed input.
                                let input = {};
                                try {
                                    input = pending.json.trim() ? JSON.parse(pending.json) : {};
                                }
                                catch {
                                    input = {};
                                }
                                progress.report(new vscode.LanguageModelToolCallPart(pending.id, pending.name, input));
                            }
                        }
                        else if (event.type === "error") {
                            throw new Error(event.error?.message ?? "Anthropic returned an error");
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    /**
     * Token count. Both providers tokenize server-side, so this is the
     * conventional ~4-characters-per-token estimate; VS Code uses it for budget
     * hints, never for billing.
     */
    async provideTokenCount(_model, text, _token) {
        if (typeof text === "string")
            return Math.ceil(text.length / 4);
        // Count every part, not just text: tool results are most of the bulk in an
        // agent run, and ignoring them reports a fraction of the real prompt.
        let chars = 0;
        for (const part of text.content) {
            if (typeof part === "string")
                chars += part.length;
            else if (part && typeof part === "object") {
                const p = part;
                if (typeof p.value === "string")
                    chars += p.value.length;
                if (typeof p.name === "string")
                    chars += p.name.length;
                if (p.input !== undefined)
                    chars += safeLength(p.input);
                if (p.content !== undefined)
                    chars += safeLength(p.content);
            }
        }
        return Math.ceil(chars / 4);
    }
}
exports.PrimalChatProvider = PrimalChatProvider;
function safeLength(value) {
    if (typeof value === "string")
        return value.length;
    try {
        return JSON.stringify(value)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
function readMaxOutputTokens() {
    const configured = vscode.workspace.getConfiguration("primal").get("maxOutputTokens");
    return typeof configured === "number" && configured > 0 ? configured : 8000;
}
async function describeAnthropicFailure(res) {
    if (res.status === 401 || res.status === 403) {
        return "Your Anthropic key was rejected. Run “Primal: Set API key” to replace it.";
    }
    if (res.status === 429)
        return "Anthropic rate-limited this key, or the account is out of credit.";
    if (res.status === 529)
        return "Anthropic is overloaded right now. Try again shortly.";
    try {
        const detail = (await res.json());
        if (detail.error?.message)
            return detail.error.message;
    }
    catch {
        // fall through
    }
    return `Anthropic request failed (${res.status})`;
}
//# sourceMappingURL=provider.js.map