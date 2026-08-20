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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const provider_1 = require("./provider");
const secrets_1 = require("./secrets");
/**
 * Primal Code — your own API keys, as first-class models everywhere VS Code
 * asks for one.
 *
 * Registration happens at activation with no `activationEvents`: the
 * `languageModelChatProviders` contribution point activates the extension when
 * the model picker is opened, so listing models must not itself require the
 * extension to already be running.
 */
function activate(context) {
    const secrets = new secrets_1.SecretStore(context.secrets);
    const provider = new provider_1.PrimalChatProvider(secrets);
    /** Ask which provider, unless there is only one sensible answer. */
    async function pickProvider(purpose) {
        const ids = Object.keys(secrets_1.PROVIDERS);
        const configured = await secrets.configured();
        const choice = await vscode.window.showQuickPick(ids.map((id) => ({
            label: secrets_1.PROVIDERS[id].label,
            description: configured.includes(id) ? "key set" : undefined,
            id,
        })), { title: `Primal Code · ${purpose}`, placeHolder: "Choose a provider" });
        return choice?.id;
    }
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("primal", provider), vscode.commands.registerCommand("primal.setApiKey", async (preselected) => {
        const id = preselected ?? (await pickProvider("Set API key"));
        if (!id)
            return;
        const key = await secrets.prompt(id);
        if (!key)
            return;
        // Tell VS Code to re-query: the model list was missing this provider.
        provider.refresh();
        void vscode.window.showInformationMessage(`Primal Code is ready. Pick a ${id === "openai" ? "GPT" : "Claude"} model in Chat.`);
    }), vscode.commands.registerCommand("primal.clearApiKey", async () => {
        const id = await pickProvider("Sign out");
        if (!id)
            return;
        await secrets.clear(id);
        provider.refresh();
        void vscode.window.showInformationMessage(`${secrets_1.PROVIDERS[id].label} key removed from your keychain.`);
    }), vscode.commands.registerCommand("primal.manageModels", async () => {
        const configured = await secrets.configured();
        const summary = configured.length === 0
            ? "No API keys set"
            : `Signed in: ${configured.map((id) => secrets_1.PROVIDERS[id].label).join(", ")}`;
        const choice = await vscode.window.showQuickPick([
            { label: "$(key) Set or replace an API key", id: "set" },
            ...(configured.length > 0 ? [{ label: "$(sign-out) Remove a key", id: "clear" }] : []),
        ], { title: "Primal Code", placeHolder: summary });
        if (choice?.id === "set")
            await vscode.commands.executeCommand("primal.setApiKey");
        if (choice?.id === "clear")
            await vscode.commands.executeCommand("primal.clearApiKey");
    }));
}
function deactivate() {
    // Everything is disposed through context.subscriptions.
}
//# sourceMappingURL=extension.js.map