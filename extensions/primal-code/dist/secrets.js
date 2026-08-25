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
exports.SecretStore = exports.PROVIDERS = void 0;
const vscode = __importStar(require("vscode"));
exports.PROVIDERS = {
    anthropic: {
        label: "Anthropic (Claude)",
        prefix: "sk-ant-",
        consoleUrl: "https://console.anthropic.com/settings/keys",
    },
    openai: {
        label: "OpenAI (GPT)",
        prefix: "sk-",
        consoleUrl: "https://platform.openai.com/api-keys",
    },
    google: {
        label: "Google (Gemini)",
        consoleUrl: "https://aistudio.google.com/apikey",
    },
    deepseek: {
        label: "DeepSeek",
        prefix: "sk-",
        consoleUrl: "https://platform.deepseek.com/api_keys",
    },
    kimi: {
        label: "Kimi (Moonshot)",
        prefix: "sk-",
        consoleUrl: "https://platform.moonshot.ai/console/api-keys",
    },
    glm: {
        label: "GLM (Zhipu / Z.ai)",
        consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
    minimax: {
        label: "MiniMax",
        consoleUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    },
};
const storageKey = (provider) => `primal.${provider}ApiKey`;
class SecretStore {
    secrets;
    constructor(secrets) {
        this.secrets = secrets;
    }
    get(provider) {
        return this.secrets.get(storageKey(provider));
    }
    async store(provider, value) {
        await this.secrets.store(storageKey(provider), value.trim());
    }
    async clear(provider) {
        await this.secrets.delete(storageKey(provider));
    }
    /** Which providers currently have a key. */
    async configured() {
        const ids = Object.keys(exports.PROVIDERS);
        const present = await Promise.all(ids.map(async (id) => ((await this.get(id)) ? id : null)));
        return present.filter((id) => id !== null);
    }
    /** Ask for a key, validating the shape before it is stored. */
    async prompt(provider) {
        const info = exports.PROVIDERS[provider];
        const value = await vscode.window.showInputBox({
            title: `Primal Code · ${info.label}`,
            prompt: `Paste your ${info.label} API key. It is stored in your OS keychain and sent only to the provider.`,
            placeHolder: `${info.prefix}…`,
            password: true,
            ignoreFocusOut: true,
            validateInput: (input) => {
                const trimmed = input.trim();
                if (!trimmed)
                    return "A key is required.";
                // Cheap shape check only. The first request is the real check; anything
                // stricter risks rejecting a valid future key format.
                if (!trimmed.startsWith(info.prefix))
                    return `That key should start with “${info.prefix}”.`;
                return null;
            },
        });
        if (!value)
            return undefined;
        await this.store(provider, value);
        return value.trim();
    }
}
exports.SecretStore = SecretStore;
//# sourceMappingURL=secrets.js.map