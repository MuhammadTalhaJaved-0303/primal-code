/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';

/**
 * Just enough `multipart/form-data` to upload one audio file with a couple of
 * text fields. Electron's `net` module posts a buffer, and there is no FormData
 * on that side, so we assemble the body ourselves.
 */

export interface IMultipartTextField {
	readonly name: string;
	readonly value: string;
}

export interface IMultipartFilePart {
	readonly name: string;
	readonly filename: string;
	readonly contentType: string;
	readonly data: Uint8Array;
}

/** RFC 2046 boundary characters, minus the space that is only legal mid-boundary. */
const LEGAL_BOUNDARY = /^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/;

export function multipartContentType(boundary: string): string {
	assertLegalBoundary(boundary);
	return `multipart/form-data; boundary=${boundary}`;
}

function assertLegalBoundary(boundary: string): void {
	if (!LEGAL_BOUNDARY.test(boundary)) {
		throw new Error('Multipart boundary contains characters that would corrupt the request.');
	}
}

/**
 * A field or file name carrying a quote or a newline would let a caller forge
 * extra headers, so names are checked rather than escaped.
 */
function assertLegalName(value: string, what: string): void {
	if (/["\r\n]/.test(value)) {
		throw new Error(`Multipart ${what} contains characters that would corrupt the request.`);
	}
}

export function buildMultipartBody(
	boundary: string,
	fields: readonly IMultipartTextField[],
	files: readonly IMultipartFilePart[],
): Uint8Array {
	assertLegalBoundary(boundary);

	const chunks: VSBuffer[] = [];

	for (const field of fields) {
		assertLegalName(field.name, 'field name');
		chunks.push(VSBuffer.fromString(
			`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
		));
	}

	for (const file of files) {
		assertLegalName(file.name, 'field name');
		assertLegalName(file.filename, 'file name');
		assertLegalName(file.contentType, 'content type');
		chunks.push(VSBuffer.fromString(
			`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
			+ `Content-Type: ${file.contentType}\r\n\r\n`,
		));
		chunks.push(VSBuffer.wrap(file.data));
		chunks.push(VSBuffer.fromString('\r\n'));
	}

	chunks.push(VSBuffer.fromString(`--${boundary}--\r\n`));

	return VSBuffer.concat(chunks).buffer;
}
