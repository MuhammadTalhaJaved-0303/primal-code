"use strict";
/**
 * Translation between VS Code's chat model and OpenAI's Chat Completions API.
 *
 * OpenAI's shape differs from Anthropic's in ways that break things quietly if
 * you assume they are the same:
 * - Tool RESULTS are their own message role ("tool"), not content blocks on a
 *   user message.
 * - Tool CALLS live in `tool_calls` on the assistant message, not inline with
 *   the text, and their arguments are a JSON *string* rather than an object.
 * - An assistant message that only calls tools must still be sent, with
 *   `content: null` — dropping it orphans the tool results that follow, and the
 *   API rejects the whole request.
 *
 * Pure, so it is the part that is tested.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toOpenAiMessages = toOpenAiMessages;
exports.toOpenAiTools = toOpenAiTools;
exports.selectChatModels = selectChatModels;
const messages_1 = require("./messages");
function isText(p) {
    return typeof p === "object" && p !== null && typeof p.value === "string";
}
function isCall(p) {
    const c = p;
    return (typeof p === "object" && p !== null && typeof c.callId === "string" && typeof c.name === "string" && typeof c.input === "object");
}
function isResult(p) {
    const r = p;
    return typeof p === "object" && p !== null && typeof r.callId === "string" && Array.isArray(r.content);
}
function flatten(parts) {
    const out = [];
    for (const part of parts) {
        if (isText(part))
            out.push(part.value);
        else if (typeof part === "string")
            out.push(part);
        else {
            try {
                out.push(JSON.stringify(part));
            }
            catch {
                // Unserializable parts are dropped rather than failing the turn.
            }
        }
    }
    return out.join("\n");
}
/** Convert VS Code's messages into OpenAI's Chat Completions shape. */
function toOpenAiMessages(messages) {
    const out = [];
    for (const message of messages) {
        const isAssistant = message.role === messages_1.ROLE_ASSISTANT;
        const texts = [];
        const calls = [];
        for (const part of message.content) {
            // Order matters: a call also has `name`, a result also has `content`.
            if (isCall(part)) {
                calls.push({
                    id: part.callId,
                    type: "function",
                    // OpenAI wants the arguments as a JSON string, not an object.
                    function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
                });
            }
            else if (isResult(part)) {
                // Tool results are their own message and must not be merged into text.
                out.push({
                    role: "tool",
                    tool_call_id: part.callId,
                    // An empty result still needs a body or the model sees nothing.
                    content: flatten(part.content) || "(no output)",
                });
            }
            else if (isText(part)) {
                if (part.value.length > 0)
                    texts.push(part.value);
            }
            else if (typeof part === "string" && part.length > 0) {
                texts.push(part);
            }
        }
        const text = texts.join("\n");
        if (calls.length > 0) {
            // Assistant turns that only call tools still have to be sent: without
            // them the following tool results reference a call that never happened.
            out.push({ role: "assistant", content: text || null, tool_calls: calls });
        }
        else if (text.length > 0) {
            out.push({ role: isAssistant ? "assistant" : "user", content: text });
        }
    }
    return out;
}
/** Convert VS Code's tool declarations to OpenAI's function schema. */
function toOpenAiTools(tools) {
    if (!tools?.length)
        return [];
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description || tool.name,
            // A function with no schema still needs a valid object schema.
            parameters: tool.inputSchema && typeof tool.inputSchema === "object"
                ? { type: "object", ...tool.inputSchema }
                : { type: "object", properties: {} },
        },
    }));
}
/**
 * Which of an account's models can actually hold a tool-using chat.
 *
 * The models endpoint returns embeddings, audio, image and moderation models
 * too, and offering those in a chat picker produces confusing failures at
 * request time rather than an honest absence.
 */
const CHAT_MODEL = /^(gpt-[45]|o[1-9])/i;
const NOT_CHAT = /(audio|realtime|image|embedding|tts|whisper|moderation|transcribe|search|dall-e|codex-mini)/i;
/**
 * Dated snapshots ("-2024-05-13", "-0613") and legacy generations make the
 * picker read like an API dump. Curate the way Cursor does: current
 * generation only, canonical ids only.
 */
const DATED_SNAPSHOT = /-\d{4}(-\d{2}-\d{2})?$/;
const CURRENT_GENERATION = /^(gpt-5|o[34])/;
function selectChatModels(ids) {
    const curated = ids
        .filter((id) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id))
        .filter((id) => !DATED_SNAPSHOT.test(id))
        .filter((id) => CURRENT_GENERATION.test(id))
        // Newest generation first, then alphabetically for a stable picker order.
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    // A key scoped to older models only should still show something usable.
    if (curated.length > 0) {
        return curated;
    }
    return ids
        .filter((id) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id) && !DATED_SNAPSHOT.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .slice(0, 8);
}
//# sourceMappingURL=openai-messages.js.map