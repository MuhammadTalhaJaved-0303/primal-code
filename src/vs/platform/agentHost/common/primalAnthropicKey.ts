/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Secret-storage key holding the user's Anthropic API key for the Claude agent.
 *
 * Written by the workbench commands `primalCode.setAnthropicApiKey` /
 * `primalCode.clearAnthropicApiKey` through `ISecretStorageService` (encrypted,
 * APPLICATION scope), and read by the electron-main agent-host starter, which
 * decrypts it and hands it to the agent host process as `ANTHROPIC_API_KEY`.
 * The key therefore never touches disk in plain text and never leaves the
 * machine except in requests to Anthropic itself.
 */
export const PRIMAL_ANTHROPIC_API_KEY_SECRET_KEY = 'primalCode.anthropicApiKey';

/** Command ids for managing the stored key (referenced from chat UX). */
export const PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID = 'primalCode.setAnthropicApiKey';
export const PRIMAL_CLEAR_ANTHROPIC_KEY_COMMAND_ID = 'primalCode.clearAnthropicApiKey';
