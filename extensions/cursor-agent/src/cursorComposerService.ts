/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getEditorLabel, getEditorSelectionSnapshot, getPreferredCodeEditor } from './editorContext';

const MAX_ATTACHMENT_PREVIEW = 220;
const MAX_FILE_PREVIEW = 260;
const MAX_PROBLEM_PREVIEW = 240;

type CursorComposerAttachmentKind = 'selection' | 'file' | 'problems';

interface ICursorComposerAttachment {
	readonly id: string;
	readonly kind: CursorComposerAttachmentKind;
	readonly label: string;
	readonly detail: string;
	readonly preview: string;
	readonly content: string;
}

export interface ICursorComposerAttachmentState {
	readonly id: string;
	readonly kind: CursorComposerAttachmentKind;
	readonly label: string;
	readonly detail: string;
	readonly preview: string;
}

export interface ICursorComposerState {
	readonly attachments: readonly ICursorComposerAttachmentState[];
}

export class CursorComposerService extends vscode.Disposable {

	private readonly _onDidChangeState = new vscode.EventEmitter<ICursorComposerState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private attachments: ICursorComposerAttachment[] = [];

	constructor() {
		super(() => {
			this._onDidChangeState.dispose();
		});
	}

	getState(): ICursorComposerState {
		return {
			attachments: this.attachments.map(attachment => ({
				id: attachment.id,
				kind: attachment.kind,
				label: attachment.label,
				detail: attachment.detail,
				preview: attachment.preview
			}))
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

	addSelectionAttachment(): boolean {
		const editor = getPreferredCodeEditor();
		const snapshot = getEditorSelectionSnapshot(editor, MAX_ATTACHMENT_PREVIEW);
		if (!editor || !snapshot) {
			return false;
		}

		const content = [
			`Attached selection from ${snapshot.fileLabel}`,
			`Language: ${snapshot.language}`,
			`Lines: ${snapshot.startLine}-${snapshot.endLine}`,
			'',
			'```' + snapshot.language,
			editor.document.getText(editor.selection),
			'```'
		].join('\n');

		this.upsertAttachment({
			id: `selection:${editor.document.uri.toString()}:${editor.selection.start.line}:${editor.selection.start.character}:${editor.selection.end.line}:${editor.selection.end.character}`,
			kind: 'selection',
			label: snapshot.fileLabel,
			detail: vscode.l10n.t('Selection • Lines {0}-{1}', snapshot.startLine, snapshot.endLine),
			preview: snapshot.preview || vscode.l10n.t('Empty selection'),
			content
		});
		return true;
	}

	addCurrentFileAttachment(): boolean {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return false;
		}

		const document = editor.document;
		const language = document.languageId || 'plaintext';
		this.upsertAttachment({
			id: `file:${document.uri.toString()}`,
			kind: 'file',
			label: getEditorLabel(document.uri),
			detail: vscode.l10n.t('Current File • {0}', language),
			preview: truncateText(document.getText().trim(), MAX_FILE_PREVIEW) || vscode.l10n.t('Empty file'),
			content: [
				`Attached file: ${getEditorLabel(document.uri)}`,
				`Language: ${language}`,
				'',
				'```' + language,
				document.getText(),
				'```'
			].join('\n')
		});
		return true;
	}

	addProblemsAttachment(): boolean {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			return false;
		}

		const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
		if (!diagnostics.length) {
			return false;
		}

		const lines = diagnostics.map((diagnostic, index) => {
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const source = diagnostic.source ? ` (${diagnostic.source})` : '';
			return `${index + 1}. [${formatSeverity(diagnostic.severity)}] Line ${line}, Column ${column}${source}: ${diagnostic.message}`;
		});

		this.upsertAttachment({
			id: `problems:${editor.document.uri.toString()}`,
			kind: 'problems',
			label: getEditorLabel(editor.document.uri),
			detail: vscode.l10n.t('Problems • {0}', diagnostics.length),
			preview: truncateText(lines.join('\n'), MAX_PROBLEM_PREVIEW),
			content: [
				`Attached diagnostics for: ${getEditorLabel(editor.document.uri)}`,
				'',
				...lines
			].join('\n')
		});
		return true;
	}

	buildAttachmentContext(): string | undefined {
		if (!this.attachments.length) {
			return undefined;
		}

		return [
			'Attached chat context:',
			...this.attachments.map(attachment => attachment.content)
		].join('\n\n');
	}

	private upsertAttachment(attachment: ICursorComposerAttachment): void {
		this.attachments = [
			attachment,
			...this.attachments.filter(existing => existing.id !== attachment.id)
		].slice(0, 6);
		this.fireState();
	}

	private fireState(): void {
		this._onDidChangeState.fire(this.getState());
	}
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 12))}\n...[truncated]`;
}

function formatSeverity(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return 'Error';
		case vscode.DiagnosticSeverity.Warning:
			return 'Warning';
		case vscode.DiagnosticSeverity.Information:
			return 'Information';
		case vscode.DiagnosticSeverity.Hint:
			return 'Hint';
		default:
			return 'Unknown';
	}
}
