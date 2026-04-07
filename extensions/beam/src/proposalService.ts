/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getEditorLabel, getPreferredCodeEditor } from './editorContext';
import { InlineDiffDecorator } from './inlineDiffDecorator';

const PROPOSAL_SCHEME = 'beam-proposal';

export interface IBeamProposalState {
	readonly active: boolean;
	readonly targetLabel?: string;
	readonly mode?: 'replace' | 'insert' | 'file';
	readonly reopenable?: boolean;
	readonly currentIndex?: number;
	readonly total?: number;
	readonly files?: readonly IBeamProposalFileSummary[];
	readonly hasMultipleFiles?: boolean;
}

export interface IBeamProposalFileSummary {
	readonly id: string;
	readonly uri: vscode.Uri;
	readonly label: string;
	readonly mode: 'replace' | 'insert' | 'file';
	readonly isActive: boolean;
}

export interface IBeamActiveProposal {
	readonly id: string;
	readonly originalUri: vscode.Uri;
	readonly firstChangeLine: number;
	readonly currentIndex: number;
	readonly total: number;
}

interface IBeamProposal {
	readonly id: string;
	readonly originalUri: vscode.Uri;
	readonly targetLabel: string;
	readonly originalText: string;
	readonly proposedText: string;
	readonly mode: 'replace' | 'insert' | 'file';
	readonly isNewFile: boolean;
	readonly selection?: vscode.Range;
	readonly firstChangeLine?: number;
}

export class BeamProposalService implements vscode.TextDocumentContentProvider, vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	private readonly _onDidChangeState = new vscode.EventEmitter<IBeamProposalState>();
	readonly onDidChange = this._onDidChange.event;
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly proposals = new Map<string, IBeamProposal>();
	private readonly proposalOrder: string[] = [];
	private activeProposalId: string | undefined;
	private readonly providerRegistration: vscode.Disposable;
	private readonly inlineDiffDecorator: InlineDiffDecorator;

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.providerRegistration = vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this);
		this.inlineDiffDecorator = new InlineDiffDecorator();
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._onDidChangeState.dispose();
		this.providerRegistration.dispose();
		this.inlineDiffDecorator.dispose();
	}

	getState(): IBeamProposalState {
		const proposal = this.getActiveProposalEntry();
		const currentIndex = proposal ? this.proposalOrder.indexOf(proposal.id) : -1;
		return {
			active: Boolean(proposal),
			targetLabel: proposal?.targetLabel,
			mode: proposal?.mode,
			reopenable: Boolean(proposal),
			currentIndex: currentIndex >= 0 ? currentIndex + 1 : undefined,
			total: this.proposalOrder.length || undefined,
			hasMultipleFiles: this.proposalOrder.length > 1,
			files: this.proposalOrder.map(id => {
				const item = this.proposals.get(id)!;
				return {
					id,
					uri: item.originalUri,
					label: item.targetLabel,
					mode: item.mode,
					isActive: id === this.activeProposalId
				};
			})
		};
	}

	getActiveProposal(): IBeamActiveProposal | undefined {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return undefined;
		}

		return {
			id: proposal.id,
			originalUri: proposal.originalUri,
			firstChangeLine: proposal.firstChangeLine ?? 0,
			currentIndex: this.proposalOrder.indexOf(proposal.id) + 1,
			total: this.proposalOrder.length
		};
	}

	async openPendingChange(target: vscode.Uri | string): Promise<void> {
		const proposal = this.findProposalByTarget(target);
		if (!proposal) {
			return;
		}

		this.activeProposalId = proposal.id;
		await this.showProposal(proposal, { preferDiff: true });
		this.fireState();
	}

	async focusActiveProposalInEditor(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.showProposal(proposal, { preferDiff: false });
	}

	async showNextProposal(): Promise<void> {
		await this.showProposalByOffset(1);
	}

	async showPreviousProposal(): Promise<void> {
		await this.showProposalByOffset(-1);
	}

	reset(): void {
		if (!this.activeProposalId && !this.proposals.size) {
			return;
		}

		this.clearAllInlineDecorations();
		this.proposals.clear();
		this.proposalOrder.length = 0;
		this.activeProposalId = undefined;
		this.fireState();
	}

	async createProposalFromCodeBlock(code: string, mode: 'replace' | 'insert'): Promise<void> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			void vscode.window.showInformationMessage(vscode.l10n.t('请先打开一个文本编辑器，再创建 Beam 的编辑提议。'));
			return;
		}

		if (mode === 'replace' && editor.selections.every(selection => selection.isEmpty)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('请先选中要替换的文本，再创建编辑提议。'));
			return;
		}

		const selection = editor.selection.isEmpty ? undefined : editor.selection;
		const originalUri = editor.document.uri;
		const originalText = editor.document.getText();
		const proposedText = applyProposalText(editor, code, mode);
		await this.upsertProposal({
			originalUri,
			targetLabel: getEditorLabel(originalUri),
			originalText,
			proposedText,
			mode,
			isNewFile: false,
			selection
		}, { openDiff: true, preserveFocus: false });
	}

	async createFileProposal(
		uri: vscode.Uri,
		proposedText: string,
		mode: 'replace' | 'insert' | 'file' = 'file',
		options: { openDiff?: boolean; preserveFocus?: boolean } = {}
	): Promise<void> {
		const { text: originalText, exists } = await this.readUriText(uri);
		await this.upsertProposal({
			originalUri: uri,
			targetLabel: getEditorLabel(uri),
			originalText,
			proposedText,
			mode,
			isNewFile: !exists
		}, {
			openDiff: options.openDiff ?? true,
			preserveFocus: options.preserveFocus ?? true
		});
	}

	async acceptActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.applyProposal(proposal);
		this.log(vscode.l10n.t('已接受 {0} 的编辑提议。', proposal.targetLabel));
		await this.removeProposal(proposal.id, true);
	}

	rejectActiveProposal(): void {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		this.log(vscode.l10n.t('已拒绝 {0} 的编辑提议。', proposal.targetLabel));
		void this.removeProposal(proposal.id, false);
	}

	async reopenActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.showProposal(proposal, { preferDiff: true });
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const id = uri.path.replace(/^\//, '');
		return this.proposals.get(id)?.proposedText ?? '';
	}

	private async showProposalByOffset(offset: number): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal || this.proposalOrder.length < 2) {
			return;
		}

		const currentIndex = this.proposalOrder.indexOf(proposal.id);
		if (currentIndex < 0) {
			return;
		}

		const nextIndex = (currentIndex + offset + this.proposalOrder.length) % this.proposalOrder.length;
		const nextProposal = this.proposals.get(this.proposalOrder[nextIndex]);
		if (!nextProposal) {
			return;
		}

		this.activeProposalId = nextProposal.id;
		await this.showProposal(nextProposal, { preferDiff: true });
		this.fireState();
	}

	private async upsertProposal(
		value: Omit<IBeamProposal, 'id' | 'firstChangeLine'>,
		options: { openDiff: boolean; preserveFocus: boolean }
	): Promise<void> {
		const existing = Array.from(this.proposals.values()).find(item => item.originalUri.toString() === value.originalUri.toString());
		const nextId = existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const proposal: IBeamProposal = {
			...value,
			id: nextId,
			firstChangeLine: existing?.firstChangeLine
		};

		this.proposals.set(nextId, proposal);
		if (!existing) {
			this.proposalOrder.push(nextId);
		}
		this.activeProposalId = nextId;

		const activeEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === value.originalUri.toString());
		if (activeEditor) {
			const diffRange = this.inlineDiffDecorator.showInlineDiff(activeEditor, value.originalText, value.proposedText);
			this.proposals.set(nextId, {
				...proposal,
				firstChangeLine: diffRange.firstChangeLine
			});
		}

		await this.showProposal(this.proposals.get(nextId)!, {
			preferDiff: options.openDiff,
			preserveFocus: options.preserveFocus
		});
		this.log(vscode.l10n.t('已在编辑器中显示 {0} 的提议预览。', value.targetLabel));
		this.fireState();
	}

	private async showProposal(
		proposal: IBeamProposal,
		options: { preferDiff: boolean; preserveFocus?: boolean }
	): Promise<void> {
		const proposalUri = this.getProposalUri(proposal.id);
		this._onDidChange.fire(proposalUri);

		if (options.preferDiff) {
			const originalUri = proposal.isNewFile
				? this.getUntitledPreviewUri(proposal.originalUri)
				: proposal.originalUri;
			await vscode.workspace.openTextDocument(originalUri);
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				proposalUri,
				this.getDiffTitle(proposal),
				{ preview: false, preserveFocus: Boolean(options.preserveFocus) }
			);
			return;
		}

		if (proposal.isNewFile) {
			const document = await vscode.workspace.openTextDocument(proposalUri);
			await vscode.window.showTextDocument(document, {
				preview: false,
				preserveFocus: Boolean(options.preserveFocus)
			});
			return;
		}

		const document = await vscode.workspace.openTextDocument(proposal.originalUri);
		const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: Boolean(options.preserveFocus) });
		const diffRange = this.inlineDiffDecorator.showInlineDiff(editor, proposal.originalText, proposal.proposedText);
		this.proposals.set(proposal.id, {
			...proposal,
			firstChangeLine: diffRange.firstChangeLine
		});
		if (diffRange.hasChanges) {
			const line = Math.min(diffRange.firstChangeLine, document.lineCount - 1);
			const range = document.lineAt(Math.max(0, line)).range;
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	private async applyProposal(proposal: IBeamProposal): Promise<void> {
		if (proposal.isNewFile && !await this.uriExists(proposal.originalUri)) {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(proposal.originalUri, { ignoreIfExists: true });
			edit.insert(proposal.originalUri, new vscode.Position(0, 0), proposal.proposedText);
			await vscode.workspace.applyEdit(edit);
			return;
		}

		const document = await vscode.workspace.openTextDocument(proposal.originalUri);
		const fullRange = fullDocumentRange(document);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(proposal.originalUri, fullRange, proposal.proposedText);
		await vscode.workspace.applyEdit(edit);

		const activeEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === proposal.originalUri.toString());
		if (activeEditor) {
			this.inlineDiffDecorator.clearDecorations(activeEditor);
		}
	}

	private async removeProposal(id: string, revealNext: boolean): Promise<void> {
		const proposal = this.proposals.get(id);
		if (!proposal) {
			return;
		}

		const activeEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === proposal.originalUri.toString());
		if (activeEditor) {
			this.inlineDiffDecorator.clearDecorations(activeEditor);
		}

		this.proposals.delete(id);
		const index = this.proposalOrder.indexOf(id);
		if (index >= 0) {
			this.proposalOrder.splice(index, 1);
		}

		if (!this.proposalOrder.length) {
			this.activeProposalId = undefined;
			this.fireState();
			return;
		}

		const nextIndex = Math.min(index, this.proposalOrder.length - 1);
		this.activeProposalId = this.proposalOrder[nextIndex];
		const nextProposal = this.getActiveProposalEntry();
		if (revealNext && nextProposal) {
			await this.showProposal(nextProposal, { preferDiff: true });
		}
		this.fireState();
	}

	private getActiveProposalEntry(): IBeamProposal | undefined {
		return this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
	}

	private getProposalUri(id: string): vscode.Uri {
		return vscode.Uri.from({
			scheme: PROPOSAL_SCHEME,
			path: `/${id}`
		});
	}

	private getUntitledPreviewUri(uri: vscode.Uri): vscode.Uri {
		return vscode.Uri.from({
			scheme: 'untitled',
			path: uri.path
		});
	}

	private getDiffTitle(proposal: IBeamProposal): string {
		const index = this.proposalOrder.indexOf(proposal.id);
		if (this.proposalOrder.length <= 1 || index < 0) {
			return vscode.l10n.t('Beam 提议：{0}', proposal.targetLabel);
		}

		return vscode.l10n.t('Beam 提议：{0} ({1}/{2})', proposal.targetLabel, index + 1, this.proposalOrder.length);
	}

	private findProposalByTarget(target: vscode.Uri | string): IBeamProposal | undefined {
		if (typeof target === 'string') {
			return this.proposals.get(target);
		}

		return Array.from(this.proposals.values()).find(item => item.originalUri.toString() === target.toString());
	}

	private clearAllInlineDecorations(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.inlineDiffDecorator.clearDecorations(editor);
		}
	}

	private fireState(): void {
		this._onDidChangeState.fire(this.getState());
	}

	private async readUriText(uri: vscode.Uri): Promise<{ text: string; exists: boolean }> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			return {
				text: document.getText(),
				exists: true
			};
		} catch {
			return {
				text: '',
				exists: false
			};
		}
	}

	private async uriExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
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
