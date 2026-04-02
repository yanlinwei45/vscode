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
			mode: proposal?.mode
		};
	}

	async createProposalFromCodeBlock(code: string, mode: 'replace' | 'insert'): Promise<void> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Open a text editor before creating a proposal from Cursor Agent.'));
			return;
		}

		if (mode === 'replace' && editor.selections.every(selection => selection.isEmpty)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Select text before creating a replacement proposal from Cursor Agent.'));
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
			vscode.l10n.t('Cursor Proposal: {0}', targetLabel),
			{ preview: true }
		);
		this.log(vscode.l10n.t('Opened proposal diff for {0}.', targetLabel));
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

		this.log(vscode.l10n.t('Accepted proposal for {0}.', proposal.targetLabel));
		this.clearActiveProposal();
	}

	rejectActiveProposal(): void {
		const proposal = this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
		if (!proposal) {
			return;
		}

		this.log(vscode.l10n.t('Rejected proposal for {0}.', proposal.targetLabel));
		this.clearActiveProposal();
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
