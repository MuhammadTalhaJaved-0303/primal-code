/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IPrimalTelemetryService } from '../../../../platform/primalTelemetry/common/primalTelemetry.js';

// A plain proxy suffices: the contract's only event follows the `onUpperCase`
// convention `ProxyChannel` recognises and every method returns a promise, so
// no hand-written channel client is needed (the update service needs one only
// for its synchronous `state` getter).
registerMainProcessRemoteService(IPrimalTelemetryService, 'primalTelemetry');
