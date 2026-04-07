/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { classifyUploadedAttachment, formatByteSize, getAttachmentTypeLabel, getImageMediaType, getPreferredExtensionForMediaType } from '../attachmentUtils';

suite('Beam Attachment Utils', () => {

	test('classifies image, pdf, text and unsupported uploads', () => {
		assert.strictEqual(classifyUploadedAttachment('demo.png', Uint8Array.from([137, 80, 78, 71])), 'image');
		assert.strictEqual(classifyUploadedAttachment('demo.pdf', Uint8Array.from([37, 80, 68, 70])), 'pdf');
		assert.strictEqual(classifyUploadedAttachment('demo.ts', Buffer.from('const value = 1;\n', 'utf8')), 'text');
		assert.strictEqual(classifyUploadedAttachment('pasted', Uint8Array.from([137, 80, 78, 71]), 'image/png'), 'image');
		assert.strictEqual(classifyUploadedAttachment('pasted', Uint8Array.from([37, 80, 68, 70]), 'application/pdf'), 'pdf');
		assert.strictEqual(classifyUploadedAttachment('demo.bin', Uint8Array.from([0, 159, 255, 10])), 'unsupported');
	});

	test('returns media types and friendly labels', () => {
		assert.strictEqual(getImageMediaType('photo.jpeg'), 'image/jpeg');
		assert.strictEqual(getImageMediaType('graphic.webp'), 'image/webp');
		assert.strictEqual(getImageMediaType('notes.txt'), undefined);
		assert.strictEqual(getPreferredExtensionForMediaType('image/png'), 'png');
		assert.strictEqual(getPreferredExtensionForMediaType('application/pdf'), 'pdf');
		assert.strictEqual(getPreferredExtensionForMediaType('text/plain'), undefined);
		assert.strictEqual(getAttachmentTypeLabel('archive.tar.gz'), 'GZ');
		assert.strictEqual(getAttachmentTypeLabel('README'), 'TXT');
	});

	test('formats file sizes for ui display', () => {
		assert.strictEqual(formatByteSize(512), '512 B');
		assert.strictEqual(formatByteSize(1536), '1.5 KB');
		assert.strictEqual(formatByteSize(2 * 1024 * 1024), '2 MB');
	});
});
