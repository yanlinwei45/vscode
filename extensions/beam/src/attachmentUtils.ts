/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

export type BeamUploadKind = 'image' | 'pdf' | 'text' | 'unsupported';

const IMAGE_MEDIA_TYPES = new Map<string, string>([
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.png', 'image/png'],
	['.gif', 'image/gif'],
	['.webp', 'image/webp']
]);

const MEDIA_TYPE_EXTENSIONS = new Map<string, string>([
	['image/jpeg', 'jpg'],
	['image/png', 'png'],
	['image/gif', 'gif'],
	['image/webp', 'webp'],
	['application/pdf', 'pdf']
]);

export function classifyUploadedAttachment(fileName: string, bytes: Uint8Array, mediaType?: string): BeamUploadKind {
	if (mediaType?.startsWith('image/')) {
		return 'image';
	}

	if (mediaType === 'application/pdf') {
		return 'pdf';
	}

	if (getImageMediaType(fileName)) {
		return 'image';
	}

	if (path.extname(fileName).toLowerCase() === '.pdf') {
		return 'pdf';
	}

	return isProbablyText(bytes) ? 'text' : 'unsupported';
}

export function getImageMediaType(fileName: string): string | undefined {
	return IMAGE_MEDIA_TYPES.get(path.extname(fileName).toLowerCase());
}

export function getPreferredExtensionForMediaType(mediaType: string): string | undefined {
	return MEDIA_TYPE_EXTENSIONS.get(mediaType.toLowerCase());
}

export function formatByteSize(byteLength: number): string {
	if (byteLength < 1024) {
		return `${byteLength} B`;
	}

	if (byteLength < 1024 * 1024) {
		return `${formatDecimal(byteLength / 1024)} KB`;
	}

	return `${formatDecimal(byteLength / (1024 * 1024))} MB`;
}

export function getAttachmentTypeLabel(fileName: string): string {
	const extension = path.extname(fileName).slice(1).toUpperCase();
	return extension || 'TXT';
}

function isProbablyText(bytes: Uint8Array): boolean {
	if (!bytes.length) {
		return true;
	}

	const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
	let suspicious = 0;

	for (const value of sample) {
		if (value === 0) {
			return false;
		}

		const isControlCharacter = value < 32 && value !== 9 && value !== 10 && value !== 13;
		if (isControlCharacter) {
			suspicious++;
		}
	}

	return suspicious / sample.length < 0.1;
}

function formatDecimal(value: number): string {
	if (value >= 10) {
		return Math.round(value).toString();
	}

	return value.toFixed(1).replace(/\.0$/, '');
}
