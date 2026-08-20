# Primal Code

Use your own **OpenAI** or **Anthropic** key as a first-class model everywhere VS Code asks for one: **Chat**, **agent mode**, and **inline edits**.

Primal Code registers Claude as a VS Code language model provider. It does not add another chat panel — it plugs into the one you already use, so every tool, every extension, and every language server you already have keeps working.

## Setup

1. Install the extension.
2. Run **Primal: Set API key** from the Command Palette (`Ctrl/Cmd+Shift+P`) and choose OpenAI or Anthropic.
3. Open Chat and pick one of your models from the model picker.

That's it. There is no account and no sign-up.

## Models

**OpenAI** — discovered from your account, so you see exactly the chat models your key can call (GPT-5.x, GPT-4.x, o-series). Non-chat models (embeddings, audio, image) are filtered out rather than offered and failing later.

**Anthropic** — Claude Opus 4.8, Sonnet 4.6, Haiku 4.5.

Set both if you like; they appear together in one picker. All support tool calling, so **agent mode works**: ask it to change something and it reads and edits real files in your workspace using VS Code's own approval UI.

## Your key, your code

- The key is stored in **VS Code's SecretStorage**, which is backed by your OS keychain — never in `settings.json`, which syncs across machines and ends up in screen shares and dotfile repos.
- Requests go **directly from your machine to the provider**. Primal runs no proxy and never sees your code, your prompts, or your key.
- You are billed by your provider at their rates. There is no markup, because there is nothing in between.

## Settings

| Setting | Default | Description |
|---|---|---|
| `primal.maxOutputTokens` | `8000` | Maximum tokens Claude may generate per response. |

## Commands

| Command | Description |
|---|---|
| `Primal: Set API key (OpenAI or Anthropic)` | Store or replace a key |
| `Primal: Remove an API key` | Remove a key from the keychain |
| `Primal: Manage models` | Check status, replace the key, or sign out |

## Requirements

VS Code 1.104 or later, and an [OpenAI API key](https://platform.openai.com/api-keys) or [Anthropic API key](https://console.anthropic.com/settings/keys).

## License

MIT
