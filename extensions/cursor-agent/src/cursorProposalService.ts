/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getPreferredCodeEditor } from './editorContext';

const PROPOSAL_SCHEME = 'cursor-agent-proposal';

export interface ICursorProposalState {
	readonly active: boolean;
	readonly targetLabel?: string;
	readonly mode?: 'replace' | 'insert';
	readonly reopenable?: boolean;
}

interface ICursorProposal {
	readonly id: string;
	readonly originalUri: vscode.Uri;
	readonly targetLabel: string;
	readonly originalText: string;
	readonly proposedText: string;
	readonly mode: 'replace' | 'insert';
	readonly selection?: vscode.Range;
}

export class CursorProposalService implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	private readonly _onDidChangeState = new vscode.EventEmitter<ICursorProposalState>();
	readonly onDidChange = this._onDidChange.event;
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly proposals = new Map<string, ICursorProposal>();
	private activeProposalId: string | undefined;
	private readonly providerRegistration: vscode.Disposable;

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.providerRegistration = vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this);
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._onDidChangeState.dispose();
		this.providerRegistration.dispose();
	}

	getState(): ICursorProposalState {
		const proposal = this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
		return {
			active: Boolean(proposal),
			targetLabel: proposal?.targetLabel,
			mode: proposal?.mode,
			reopenable: Boolean(proposal)
		};
	}

	reset(): void {
		if (!this.activeProposalId && !this.proposals.size) {
			return;
		}

		this.proposals.clear();
		this.activeProposalId = undefined;
		this.fireState();
	}

	async createProposalFromCodeBlock(code: string, mode: 'replace' | 'insert'): Promise<void> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u672c\u7f16\u8f91\u5668\uff0c\u518d\u521b\u5efa Cursor \u667a\u80fd\u4f53\u7684\u7f16\u8f91\u63d0\u8bae\u3002'));
			return;
		}

		if (mode === 'replace' && editor.selections.every(selection => selection.isEmpty)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u9009\u4e2d\u8981\u66ff\u6362\u7684\u6587\u672c\uff0c\u518d\u521b\u5efa\u7f16\u8f91\u63d0\u8bae\u3002'));
			return;
		}

		const selection = editor.selection.isEmpty ? undefined : editor.selection;
		const originalUri = editor.document.uri;
		const originalText = editor.document.getText();
		const proposedText = applyProposalText(editor, code, mode);
		const proposalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const targetLabel = vscode.workspace.asRelativePath(originalUri, false) || originalUri.fsPath || originalUri.toString();

		this.proposals.set(proposalId, {
			id: proposalId,
			originalUri,
			targetLabel,
			originalText,
			proposedText,
			mode,
			selection
		});
		this.activeProposalId = proposalId;
		this.fireState();

		const proposalUri = this.getProposalUri(proposalId, originalUri);
		this._onDidChange.fire(proposalUri);
		await vscode.commands.executeCommand(
			'vscode.diff',
			originalUri,
			proposalUri,
			vscode.l10n.t('Cursor \u63d0\u8bae\uff1a{0}', targetLabel),
			{ preview: true }
		);
		this.log(vscode.l10n.t('\u5df2\u6253\u5f00 {0} \u7684\u63d0\u8bae\u5bf9\u6bd4\u89c6\u56fe\u3002', targetLabel));
	}

	async acceptActiveProposal(): Promise<void> {
		const proposal = this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
		if (!proposal) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(proposal.originalUri);
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const fullRange = fullDocumentRange(document);
		await editor.edit(editBuilder => {
			editBuilder.replace(fullRange, proposal.proposedText);
		});

		this.log(vscode.l10n.t('\u5df2\u63a5\u53d7 {0} \u7684\u7f16\u8f91\u63d0\u8bae\u3002', proposal.targetLabel));
		this.clearActiveProposal();
	}

	rejectActiveProposal(): void {
		const proposal = this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
		if (!proposal) {
			return;
		}

		this.log(vscode.l10n.t('\u5df2\u62d2\u7edd {0} \u7684\u7f16\u8f91\u63d0\u8bae\u3002', proposal.targetLabel));
		this.clearActiveProposal();
	}

	async reopenActiveProposal(): Promise<void> {
		const proposal = this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
		if (!proposal) {
			return;
		}

		const proposalUri = this.getProposalUri(proposal.id, proposal.originalUri);
		this._onDidChange.fire(proposalUri);
		await vscode.commands.executeCommand(
			'vscode.diff',
			proposal.originalUri,
			proposalUri,
			vscode.l10n.t('Cursor \u63d0\u8bae\uff1a{0}', proposal.targetLabel),
			{ preview: true }
		);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const id = uri.path.replace(/^\//, '');
		return this.proposals.get(id)?.proposedText ?? '';
	}

	private clearActiveProposal(): void {
		if (this.activeProposalId) {
			this.proposals.delete(this.activeProposalId);
			this.activeProposalId = undefined;
			this.fireState();
		}
	}

	private getProposalUri(id: string, originalUri: vscode.Uri): vscode.Uri {
		return vscode.Uri.from({
			scheme: PROPOSAL_SCHEME,
			path: `/${id}`,
			query: new URLSearchParams({
				original: originalUri.toString()
			}).toString()
		});
	}

	private fireState(): void {
		this._onDidChangeState.fire(this.getState());
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function applyProposalText(editor: vscode.TextEditor, code: string, mode: 'replace' | 'insert'): string {
	const document = editor.document;
	if (mode === 'insert') {
		const selection = editor.selection;
		const offset = document.offsetAt(selection.active);
		const text = document.getText();
		return `${text.slice(0, offset)}${code}${text.slice(offset)}`;
	}

	let text = document.getText();
	const orderedSelections = [...editor.selections]
		.filter(selection => !selection.isEmpty)
		.sort((a, b) => document.offsetAt(b.start) - document.offsetAt(a.start));

	for (const selection of orderedSelections) {
		const start = document.offsetAt(selection.start);
		const end = document.offsetAt(selection.end);
		text = `${text.slice(0, start)}${code}${text.slice(end)}`;
	}

	return text;
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
	const lastLine = document.lineAt(document.lineCount - 1);
	return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
}
