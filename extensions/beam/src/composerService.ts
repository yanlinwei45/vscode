/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getEditorLabel, getEditorSelectionSnapshot, getPreferredCodeEditor } from './editorContext';

const MAX_ATTACHMENT_PREVIEW = 220;
const MAX_FILE_PREVIEW = 260;
const MAX_PROBLEM_PREVIEW = 240;
const MAX_ATTACHMENT_CONTEXT_CHARS = 7000;
const MAX_TOTAL_ATTACHMENT_CONTEXT_CHARS = 12000;

type BeamComposerAttachmentKind = 'selection' | 'file' | 'problems';

interface IBeamComposerAttachment {
	readonly id: string;
	readonly kind: BeamComposerAttachmentKind;
	readonly label: string;
	readonly detail: string;
	readonly preview: string;
	readonly content: string;
	readonly included: boolean;
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
}

interface IBeamComposerAttachmentReference {
	readonly kind: BeamComposerAttachmentKind;
	readonly label: string;
}

export interface IBeamComposerState {
	readonly attachments: readonly IBeamComposerAttachmentState[];
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
		const snapshot = getEditorSelectionSnapshot(editor, MAX_ATTACHMENT_PREVIEW);
		if (!editor || !snapshot) {
			return undefined;
		}

		const content = [
			`\u5df2\u9644\u52a0\u9009\u533a\uff1a${snapshot.fileLabel}`,
			`\u8bed\u8a00\uff1a${snapshot.language}`,
			`\u884c\u53f7\uff1a${snapshot.startLine}-${snapshot.endLine}`,
			'',
			'```' + snapshot.language,
			editor.document.getText(editor.selection),
			'```'
		].join('\n');

		return this.upsertAttachment({
			id: `selection:${editor.document.uri.toString()}:${editor.selection.start.line}:${editor.selection.start.character}:${editor.selection.end.line}:${editor.selection.end.character}`,
			kind: 'selection',
			label: snapshot.fileLabel,
			detail: vscode.l10n.t('\u9009\u533a \u00b7 \u7b2c {0}-{1} \u884c', snapshot.startLine, snapshot.endLine),
			preview: snapshot.preview || vscode.l10n.t('\u7a7a\u9009\u533a'),
			content
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

	buildAttachmentContext(prompt?: string): string | undefined {
		const attachments = this.getContextAttachments(prompt);
		if (!attachments.length) {
			return undefined;
		}

		const blocks: string[] = [];
		let used = 0;

		for (const attachment of attachments) {
			const content = truncateText(attachment.content, MAX_ATTACHMENT_CONTEXT_CHARS);
			if (blocks.length && used + content.length > MAX_TOTAL_ATTACHMENT_CONTEXT_CHARS) {
				break;
			}

			blocks.push(content);
			used += content.length;
		}

		return [
			'\u5df2\u9644\u52a0\u5230\u5bf9\u8bdd\u7684\u4e0a\u4e0b\u6587\uff1a',
			...blocks
		].join('\n\n');
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
}

function toAttachmentState(attachment: IBeamComposerAttachment): IBeamComposerAttachmentState {
	return {
		id: attachment.id,
		kind: attachment.kind,
		label: attachment.label,
		detail: attachment.detail,
		preview: attachment.preview,
		included: attachment.included,
		contentLength: attachment.content.length
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
