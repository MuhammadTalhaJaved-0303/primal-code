"use strict";
/**
 * Translation between VS Code's chat model and Anthropic's Messages API.
 *
 * This is the load-bearing part of the provider and the only part that is pure,
 * so it is the part that is tested. Everything else is I/O around it.
 *
 * The two models disagree in ways that matter:
 * - VS Code has no system role (only User=1 and Assistant=2); Anthropic takes
 *   the system prompt as a separate top-level parameter.
 * - VS Code carries tool RESULTS on user-role messages and tool CALLS on
 *   assistant-role messages, which happens to match Anthropic exactly — but the
 *   part classes are structural, not nominal, so they are detected by shape.
 * - Anthropic rejects a message with empty content, and VS Code will happily
 *   hand us one after a message whose only part was unrepresentable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_ASSISTANT = exports.ROLE_USER = void 0;
exports.toAnthropicMessages = toAnthropicMessages;
exports.toAnthropicTools = toAnthropicTools;
/** VS Code's LanguageModelChatMessageRole. */
exports.ROLE_USER = 1;
exports.ROLE_ASSISTANT = 2;
function isTextPart(part) {
    return typeof part === "object" && part !== null && typeof part.value === "string";
}
function isToolCallPart(part) {
    const p = part;
    return (typeof part === "object" &&
        part !== null &&
        typeof p.callId === "string" &&
        typeof p.name === "string" &&
        typeof p.input === "object");
}
function isToolResultPart(part) {
    const p = part;
    return typeof part === "object" && part !== null && typeof p.callId === "string" && Array.isArray(p.content);
}
/** Flatten a tool result's parts into the plain string Anthropic expects. */
function toolResultText(content) {
    const chunks = [];
    for (const part of content) {
        if (isTextPart(part))
            chunks.push(part.value);
        else if (typeof part === "string")
            chunks.push(part);
        else {
            try {
                chunks.push(JSON.stringify(part));
            }
            catch {
                // A part that cannot be serialized is dropped rather than failing the
                // whole turn; the model sees less context, not an error.
            }
        }
    }
    return chunks.join("\n");
}
/**
 * Convert VS Code's messages into Anthropic's shape.
 *
 * Messages that end up with no representable content are dropped: Anthropic
 * rejects the whole request over one empty `content` array, which would turn a
 * cosmetic gap into a failed turn.
 */
function toAnthropicMessages(messages) {
    const out = [];
    for (const message of messages) {
        const role = message.role === exports.ROLE_ASSISTANT ? "assistant" : "user";
        const blocks = [];
        for (const part of message.content) {
            // Order matters: a tool call also has a `name`, and a tool result also
            // has `content`, so the most specific shapes are tested first.
            if (isToolCallPart(part)) {
                blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input });
            }
            else if (isToolResultPart(part)) {
                blocks.push({ type: "tool_result", tool_use_id: part.callId, content: toolResultText(part.content) });
            }
            else if (isTextPart(part)) {
                // Anthropic rejects a text block that is entirely empty.
                if (part.value.length > 0)
                    blocks.push({ type: "text", text: part.value });
            }
            else if (typeof part === "string" && part.length > 0) {
                blocks.push({ type: "text", text: part });
            }
        }
        if (blocks.length > 0)
            out.push({ role, content: blocks });
    }
    return mergeAdjacent(out);
}
/**
 * Anthropic requires strictly alternating roles. VS Code can hand us two
 * consecutive messages of the same role (e.g. several tool results in a row),
 * so adjacent same-role messages are merged rather than rejected.
 */
function mergeAdjacent(messages) {
    const out = [];
    for (const message of messages) {
        const last = out[out.length - 1];
        if (last && last.role === message.role)
            last.content.push(...message.content);
        else
            out.push({ role: message.role, content: [...message.content] });
    }
    return out;
}
/**
 * Convert VS Code's tool declarations. A tool with no schema still needs a
 * well-formed empty object schema, or Anthropic rejects the request.
 */
function toAnthropicTools(tools) {
    if (!tools?.length)
        return [];
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || tool.name,
        input_schema: tool.inputSchema && typeof tool.inputSchema === "object"
            ? { type: "object", ...tool.inputSchema }
            : { type: "object", properties: {} },
    }));
}
//# sourceMappingURL=messages.js.map