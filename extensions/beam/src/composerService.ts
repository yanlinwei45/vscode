/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { getEditorLabel, getEditorSelectionSnapshot, getPreferredCodeEditor } from './editorContext';
import { classifyUploadedAttachment, formatByteSize, getAttachmentTypeLabel, getImageMediaType, getPreferredExtensionForMediaType } from './attachmentUtils';

const MAX_ATTACHMENT_PREVIEW = 220;
const MAX_FILE_PREVIEW = 260;
const MAX_PROBLEM_PREVIEW = 240;
const MAX_ATTACHMENT_CONTEXT_CHARS = 7000;
const MAX_TOTAL_ATTACHMENT_CONTEXT_CHARS = 12000;
const SELECTION_CONTEXT_PREVIEW_LINE_COUNT = 2;
const MAX_UPLOADED_TEXT_CHARS = 12000;
const MAX_BINARY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BINARY_ATTACHMENT_BYTES = 24 * 1024 * 1024;

type BeamComposerAttachmentKind = 'selection' | 'file' | 'problems' | 'upload' | 'image' | 'pdf';

interface IBeamAttachmentBinaryPayload {
	readonly mediaType: string;
	readonly data: string;
	readonly size: number;
	readonly previewUrl?: string;
}

interface IBeamComposerAttachment {
	readonly id: string;
	readonly kind: BeamComposerAttachmentKind;
	readonly label: string;
	readonly detail: string;
	readonly preview: string;
	readonly content: string;
	readonly included: boolean;
	readonly originalUri?: string;
	readonly binary?: IBeamAttachmentBinaryPayload;
}

type IBeamComposerAttachmentDraft = Omit<IBeamComposerAttachment, 'included'>;

export interface IBeamComposerAttachmentState {
	readonly id: string;
	readonly kind: BeamComposerAttachmentKind;
	readonly label: string;
	readonly detail: string;
	readonly preview: string;
	readonly included: boolean;
	readonly contentLength: number;
	readonly originalUri?: string;
	readonly previewUrl?: string;
}

interface IBeamComposerAttachmentReference {
	readonly kind: BeamComposerAttachmentKind;
	readonly label: string;
}

export interface IBeamComposerState {
	readonly attachments: readonly IBeamComposerAttachmentState[];
}

export interface IBeamComposerMessageImageAttachment {
	readonly type: 'image';
	readonly label: string;
	readonly mediaType: string;
	readonly data: string;
}

export interface IBeamComposerMessageDocumentAttachment {
	readonly type: 'document';
	readonly label: string;
	readonly mediaType: string;
	readonly data: string;
}

export interface IBeamComposerResolvedAttachments {
	readonly context: string | undefined;
	readonly images: readonly IBeamComposerMessageImageAttachment[];
	readonly documents: readonly IBeamComposerMessageDocumentAttachment[];
}

export interface IBeamWebAttachmentInput {
	readonly name?: string;
	readonly mediaType?: string;
	readonly data: string;
}

export class BeamComposerService extends vscode.Disposable {

	private readonly _onDidChangeState = new vscode.EventEmitter<IBeamComposerState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private attachments: IBeamComposerAttachment[] = [];

	constructor() {
		super(() => {
			this._onDidChangeState.dispose();
		});
	}

	getState(): IBeamComposerState {
		return {
			attachments: this.attachments.map(toAttachmentState)
		};
	}

	hasAttachments(): boolean {
		return this.attachments.length > 0;
	}

	clear(): void {
		if (!this.attachments.length) {
			return;
		}

		this.attachments = [];
		this.fireState();
	}

	removeAttachment(id: string): void {
		const nextAttachments = this.attachments.filter(attachment => attachment.id !== id);
		if (nextAttachments.length === this.attachments.length) {
			return;
		}

		this.attachments = nextAttachments;
		this.fireState();
	}

	toggleAttachment(id: string): void {
		let changed = false;
		this.attachments = this.attachments.map(attachment => {
			if (attachment.id !== id) {
				return attachment;
			}

			changed = true;
			return {
				...attachment,
				included: !attachment.included
			};
		});

		if (changed) {
			this.fireState();
		}
	}

	addSelectionAttachment(): IBeamComposerAttachmentState | undefined {
		const editor = getPreferredCodeEditor();
		const snapshot = getEditorSelectionSnapshot(
			editor,
			MAX_ATTACHMENT_PREVIEW,
			SELECTION_CONTEXT_PREVIEW_LINE_COUNT
		);
		if (!editor || !snapshot) {
			return undefined;
		}

		const contentBlocks = [
			`已附加选区：${snapshot.fileLabel}`,
			`语言：${snapshot.language}`,
			`范围：${snapshot.rangeLabel}`,
			`行号：${snapshot.startLine}-${snapshot.endLine}`,
			''
		];

		if (snapshot.contextBefore) {
			contentBlocks.push('选区前文：');
			contentBlocks.push('```' + snapshot.language);
			contentBlocks.push(snapshot.contextBefore);
			contentBlocks.push('```');
			contentBlocks.push('');
		}

		contentBlocks.push('选区内容：');
		contentBlocks.push('```' + snapshot.language);
		contentBlocks.push(snapshot.selectedText);
		contentBlocks.push('```');

		if (snapshot.contextAfter) {
			contentBlocks.push('');
			contentBlocks.push('选区后文：');
			contentBlocks.push('```' + snapshot.language);
			contentBlocks.push(snapshot.contextAfter);
			contentBlocks.push('```');
		}

		return this.upsertAttachment({
			id: `selection:${editor.document.uri.toString()}:${editor.selection.start.line}:${editor.selection.start.character}:${editor.selection.end.line}:${editor.selection.end.character}`,
			kind: 'selection',
			label: snapshot.fileLabel,
			detail: vscode.l10n.t('选区 · {0}', snapshot.rangeLabel),
			preview: snapshot.preview || vscode.l10n.t('空选区'),
			content: contentBlocks.join('\n')
		});
	}

	addCurrentFileAttachment(): IBeamComposerAttachmentState | undefined {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return undefined;
		}

		const document = editor.document;
		const language = document.languageId || 'plaintext';
		return this.upsertAttachment({
			id: `file:${document.uri.toString()}`,
			kind: 'file',
			label: getEditorLabel(document.uri),
			detail: vscode.l10n.t('\u5f53\u524d\u6587\u4ef6 \u00b7 {0}', language),
			preview: truncateText(document.getText().trim(), MAX_FILE_PREVIEW) || vscode.l10n.t('\u7a7a\u6587\u4ef6'),
			content: [
				`\u5df2\u9644\u52a0\u6587\u4ef6\uff1a${getEditorLabel(document.uri)}`,
				`\u8bed\u8a00\uff1a${language}`,
				'',
				'```' + language,
				document.getText(),
				'```'
			].join('\n')
		});
	}

	addProblemsAttachment(): IBeamComposerAttachmentState | undefined {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return undefined;
		}

		const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
		if (!diagnostics.length) {
			return undefined;
		}

		const lines = diagnostics.map((diagnostic, index) => {
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const source = diagnostic.source ? ` (${diagnostic.source})` : '';
			return `${index + 1}. [${formatSeverity(diagnostic.severity)}] \u7b2c ${line} \u884c\uff0c\u7b2c ${column} \u5217${source}\uff1a${diagnostic.message}`;
		});

		return this.upsertAttachment({
			id: `problems:${editor.document.uri.toString()}`,
			kind: 'problems',
			label: getEditorLabel(editor.document.uri),
			detail: vscode.l10n.t('\u95ee\u9898 \u00b7 {0}', diagnostics.length),
			preview: truncateText(lines.join('\n'), MAX_PROBLEM_PREVIEW),
			content: [
				`\u5df2\u9644\u52a0\u8bca\u65ad\u4fe1\u606f\uff1a${getEditorLabel(editor.document.uri)}`,
				'',
				...lines
			].join('\n')
		});
	}

	async addUploadedAttachments(uris: readonly vscode.Uri[]): Promise<IBeamComposerAttachmentState[]> {
		const results: IBeamComposerAttachmentState[] = [];

		for (const uri of uris) {
			const attachment = await this.createUploadedAttachment(uri);
			if (attachment) {
				results.push(this.upsertAttachment(attachment));
			}
		}

		return results;
	}

	addWebAttachments(items: readonly IBeamWebAttachmentInput[]): IBeamComposerAttachmentState[] {
		const results: IBeamComposerAttachmentState[] = [];

		for (const item of items) {
			const attachment = this.createWebAttachment(item);
			if (attachment) {
				results.push(this.upsertAttachment(attachment));
			}
		}

		return results;
	}

	resolveAttachments(prompt?: string): IBeamComposerResolvedAttachments {
		const attachments = this.getContextAttachments(prompt);
		if (!attachments.length) {
			return {
				context: undefined,
				images: [],
				documents: []
			};
		}

		const blocks: string[] = [];
		let used = 0;
		const images: IBeamComposerMessageImageAttachment[] = [];
		const documents: IBeamComposerMessageDocumentAttachment[] = [];

		for (const attachment of attachments) {
			if (attachment.kind === 'image' && attachment.binary) {
				images.push({
					type: 'image',
					label: attachment.label,
					mediaType: attachment.binary.mediaType,
					data: attachment.binary.data
				});
			}

			if (attachment.kind === 'pdf' && attachment.binary) {
				documents.push({
					type: 'document',
					label: attachment.label,
					mediaType: attachment.binary.mediaType,
					data: attachment.binary.data
				});
			}

			if (!attachment.content.trim()) {
				continue;
			}

			const content = truncateText(attachment.content, MAX_ATTACHMENT_CONTEXT_CHARS);
			if (blocks.length && used + content.length > MAX_TOTAL_ATTACHMENT_CONTEXT_CHARS) {
				break;
			}

			blocks.push(content);
			used += content.length;
		}

		return {
			context: blocks.length ? [
				'\u5df2\u9644\u52a0\u5230\u5bf9\u8bdd\u7684\u4e0a\u4e0b\u6587\uff1a',
				...blocks
			].join('\n\n') : undefined,
			images,
			documents
		};
	}

	private getContextAttachments(prompt?: string): readonly IBeamComposerAttachment[] {
		const included = this.attachments.filter(attachment => attachment.included);
		if (!included.length) {
			return [];
		}

		if (!prompt?.trim()) {
			return included;
		}

		const referenced = included.filter(attachment => prompt.includes(formatAttachmentReference(attachment)));
		return referenced.length ? referenced : included;
	}

	private upsertAttachment(attachment: IBeamComposerAttachmentDraft): IBeamComposerAttachmentState {
		this.assertAttachmentWithinLimits(attachment);
		this.assertTotalBinarySizeWithinLimits(attachment);
		this.attachments = [
			{
				...attachment,
				included: true
			},
			...this.attachments.filter(existing => existing.id !== attachment.id)
		].slice(0, 6);
		this.fireState();
		return toAttachmentState({
			...attachment,
			included: true
		});
	}

	private fireState(): void {
		this._onDidChangeState.fire(this.getState());
	}

	private async createUploadedAttachment(uri: vscode.Uri): Promise<IBeamComposerAttachmentDraft | undefined> {
		const fileName = path.basename(uri.fsPath || uri.path);
		if (!fileName) {
			return undefined;
		}

		const fileData = await vscode.workspace.fs.readFile(uri);
		const kind = classifyUploadedAttachment(fileName, fileData);
		if (kind === 'unsupported') {
			throw new Error(vscode.l10n.t('暂不支持将 {0} 作为 Beam 附件上传。当前支持图片、PDF 和文本文件。', fileName));
		}

		switch (kind) {
			case 'image':
				return this.createImageAttachment(uri, fileName, fileData);
			case 'pdf':
				return this.createPdfAttachment(uri, fileName, fileData);
			case 'text':
				return this.createTextAttachment(uri, fileName, fileData);
			default:
				return undefined;
		}
	}

	private createWebAttachment(item: IBeamWebAttachmentInput): IBeamComposerAttachmentDraft | undefined {
		const fileName = this.getWebAttachmentName(item);
		const fileData = Buffer.from(item.data, 'base64');
		const kind = classifyUploadedAttachment(fileName, fileData, item.mediaType);
		if (kind === 'unsupported') {
			throw new Error(vscode.l10n.t('暂不支持将 {0} 作为 Beam 附件上传。当前支持图片、PDF 和文本文件。', fileName));
		}

		const originalUri = `beam-upload:${encodeURIComponent(fileName)}`;
		switch (kind) {
			case 'image':
				return this.createImageAttachment(vscode.Uri.parse(originalUri), fileName, fileData, item.mediaType);
			case 'pdf':
				return this.createPdfAttachment(vscode.Uri.parse(originalUri), fileName, fileData);
			case 'text':
				return this.createTextAttachment(vscode.Uri.parse(originalUri), fileName, fileData);
			default:
				return undefined;
		}
	}

	private createImageAttachment(uri: vscode.Uri, fileName: string, fileData: Uint8Array, mediaTypeHint?: string): IBeamComposerAttachmentDraft {
		const mediaType = mediaTypeHint || getImageMediaType(fileName) || 'image/png';
		const sizeLabel = formatByteSize(fileData.byteLength);
		return {
			id: `image:${uri.toString()}`,
			kind: 'image',
			label: fileName,
			detail: vscode.l10n.t('图片 · {0} · {1}', getAttachmentTypeLabel(fileName), sizeLabel),
			preview: vscode.l10n.t('图片已附加，发送后 Beam 可直接查看这张图片。'),
			content: [
				`已附加图片：${fileName}`,
				`类型：${mediaType}`,
				`大小：${sizeLabel}`,
				'请结合图片内容回答用户问题。'
			].join('\n'),
			originalUri: uri.toString(),
			binary: {
				mediaType,
				data: Buffer.from(fileData).toString('base64'),
				size: fileData.byteLength,
				previewUrl: `data:${mediaType};base64,${Buffer.from(fileData).toString('base64')}`
			}
		};
	}

	private createPdfAttachment(uri: vscode.Uri, fileName: string, fileData: Uint8Array): IBeamComposerAttachmentDraft {
		const sizeLabel = formatByteSize(fileData.byteLength);
		return {
			id: `pdf:${uri.toString()}`,
			kind: 'pdf',
			label: fileName,
			detail: vscode.l10n.t('PDF · {0}', sizeLabel),
			preview: vscode.l10n.t('PDF 已附加，发送后 Beam 可直接阅读文档内容。'),
			content: [
				`已附加 PDF：${fileName}`,
				`大小：${sizeLabel}`,
				'请结合文档内容回答用户问题。'
			].join('\n'),
			originalUri: uri.toString(),
			binary: {
				mediaType: 'application/pdf',
				data: Buffer.from(fileData).toString('base64'),
				size: fileData.byteLength
			}
		};
	}

	private createTextAttachment(uri: vscode.Uri, fileName: string, fileData: Uint8Array): IBeamComposerAttachmentDraft {
		const text = Buffer.from(fileData).toString('utf8');
		const content = truncateText(text, MAX_UPLOADED_TEXT_CHARS);
		return {
			id: `upload:${uri.toString()}`,
			kind: 'upload',
			label: fileName,
			detail: vscode.l10n.t('上传文件 · {0} · {1}', getAttachmentTypeLabel(fileName), formatByteSize(fileData.byteLength)),
			preview: truncateText(content.trim(), MAX_FILE_PREVIEW) || vscode.l10n.t('空文件'),
			content: [
				`已附加上传文件：${fileName}`,
				'',
				'```',
				content,
				'```'
			].join('\n'),
			originalUri: uri.toString()
		};
	}

	private getWebAttachmentName(item: IBeamWebAttachmentInput): string {
		const trimmed = item.name?.trim();
		if (trimmed) {
			return trimmed;
		}

		const extension = item.mediaType ? getPreferredExtensionForMediaType(item.mediaType) : undefined;
		if (extension) {
			return `attachment-${Date.now()}.${extension}`;
		}

		return `attachment-${Date.now()}.txt`;
	}

	private assertAttachmentWithinLimits(attachment: IBeamComposerAttachmentDraft): void {
		if (!attachment.binary) {
			return;
		}

		if (attachment.binary.size > MAX_BINARY_ATTACHMENT_BYTES) {
			throw new Error(vscode.l10n.t('{0} 过大，当前单个图片/PDF 附件上限是 {1}。', attachment.label, formatByteSize(MAX_BINARY_ATTACHMENT_BYTES)));
		}
	}

	private assertTotalBinarySizeWithinLimits(nextAttachment: IBeamComposerAttachmentDraft): void {
		const nextSize = nextAttachment.binary?.size ?? 0;
		if (!nextSize) {
			return;
		}

		const currentSize = this.attachments
			.filter(attachment => attachment.id !== nextAttachment.id)
			.reduce((total, attachment) => total + (attachment.binary?.size ?? 0), 0);

		if (currentSize + nextSize > MAX_TOTAL_BINARY_ATTACHMENT_BYTES) {
			throw new Error(vscode.l10n.t('当前对话中的图片/PDF 附件总量过大，合计上限是 {0}。请移除一些附件后再试。', formatByteSize(MAX_TOTAL_BINARY_ATTACHMENT_BYTES)));
		}
	}
}

function toAttachmentState(attachment: IBeamComposerAttachment): IBeamComposerAttachmentState {
	return {
		id: attachment.id,
		kind: attachment.kind,
		label: attachment.label,
		detail: attachment.detail,
		preview: attachment.preview,
		included: attachment.included,
		contentLength: attachment.content.length,
		originalUri: attachment.originalUri,
		previewUrl: attachment.binary?.previewUrl
	};
}

export function formatAttachmentReference(attachment: IBeamComposerAttachmentReference): string {
	return `[@${attachment.kind}: ${attachment.label}]`;
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 12))}\n...[\u5df2\u622a\u65ad]`;
}

function formatSeverity(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return '\u9519\u8bef';
		case vscode.DiagnosticSeverity.Warning:
			return '\u8b66\u544a';
		case vscode.DiagnosticSeverity.Information:
			return '\u4fe1\u606f';
		case vscode.DiagnosticSeverity.Hint:
			return '\u63d0\u793a';
		default:
			return '\u672a\u77e5';
	}
}
