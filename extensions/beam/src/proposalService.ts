/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { getEditorLabel, getPreferredCodeEditor } from './editorContext';
import { InlineDiffDecorator } from './inlineDiffDecorator';
import { applyProposalTextToContent } from './proposalText';

const PROPOSAL_SCHEME = 'beam-proposal';

export interface IBeamProposalState {
	readonly active: boolean;
	readonly targetLabel?: string;
	readonly mode?: 'replace' | 'insert' | 'file' | 'delete';
	readonly reopenable?: boolean;
	readonly currentIndex?: number;
	readonly total?: number;
	readonly files?: readonly IBeamProposalFileSummary[];
	readonly hasMultipleFiles?: boolean;
	readonly changeSummary?: string;
	readonly applied?: boolean;
}

export interface IBeamProposalFileSummary {
	readonly id: string;
	readonly label: string;
	readonly mode: 'replace' | 'insert' | 'file' | 'delete';
	readonly isActive: boolean;
	readonly firstChangeLine?: number;
	readonly lastChangeLine?: number;
	readonly changeLabel?: string;
	readonly applied?: boolean;
}

export interface IBeamProposalChangeSummary {
	readonly id: string;
	readonly label: string;
	readonly mode: 'replace' | 'insert' | 'file' | 'delete';
	readonly firstChangeLine?: number;
	readonly lastChangeLine?: number;
	readonly addedLines: number;
	readonly deletedLines: number;
	readonly modifiedLines: number;
	readonly changeCount: number;
	readonly isNewFile: boolean;
	readonly applied: boolean;
	readonly summary: string;
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
	readonly mode: 'replace' | 'insert' | 'file' | 'delete';
	readonly isNewFile: boolean;
	readonly applied: boolean;
	readonly selection?: vscode.Range;
	readonly firstChangeLine?: number;
	readonly lastChangeLine?: number;
	readonly addedLines: number;
	readonly deletedLines: number;
	readonly modifiedLines: number;
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
			changeSummary: proposal ? this.toChangeSummary(proposal).summary : undefined,
			applied: proposal?.applied,
			files: this.proposalOrder.map(id => {
				const item = this.proposals.get(id)!;
				const summary = this.toChangeSummary(item);
				return {
					id,
					label: item.targetLabel,
					mode: item.mode,
					isActive: id === this.activeProposalId,
					firstChangeLine: summary.firstChangeLine,
					lastChangeLine: summary.lastChangeLine,
					changeLabel: summary.summary,
					applied: item.applied
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
		await this.showProposal(proposal, { preferDiff: proposal.mode === 'delete' });
		this.fireState();
	}

	async focusActiveProposalInEditor(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.showProposal(proposal, { preferDiff: proposal.mode === 'delete' });
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
		void this.closeAllProposalTabs();
		this.proposals.clear();
		this.proposalOrder.length = 0;
		this.activeProposalId = undefined;
		this.fireState();
	}

	async createProposalFromCodeBlock(code: string, mode: 'replace' | 'insert'): Promise<IBeamProposalChangeSummary> {
		const editor = getPreferredCodeEditor();
		if (!editor) {
			throw new Error(vscode.l10n.t('请先打开一个文本编辑器，再创建 Beam 的编辑提议。'));
		}

		const selection = editor.selection.isEmpty ? undefined : editor.selection;
		const originalUri = editor.document.uri;
		const originalText = editor.document.getText();
		const proposedText = applyProposalText(editor, code, mode);
		return this.upsertProposal({
			originalUri,
			targetLabel: getEditorLabel(originalUri),
			originalText,
			proposedText,
			mode,
			isNewFile: false,
			applied: false,
			addedLines: 0,
			deletedLines: 0,
			modifiedLines: 0,
			selection
		}, { openDiff: false, preserveFocus: false });
	}

	async createFileProposal(
		uri: vscode.Uri,
		proposedText: string,
		mode: 'replace' | 'insert' | 'file' | 'delete' = 'file',
		options: { openDiff?: boolean; preserveFocus?: boolean } = {}
	): Promise<IBeamProposalChangeSummary> {
		const { text: originalText, exists } = await this.readUriText(uri);
		return this.upsertProposal({
			originalUri: uri,
			targetLabel: getEditorLabel(uri),
			originalText,
			proposedText,
			mode,
			isNewFile: !exists,
			applied: false,
			addedLines: 0,
			deletedLines: 0,
			modifiedLines: 0
		}, {
			openDiff: options.openDiff ?? !exists,
			preserveFocus: options.preserveFocus ?? true
		});
	}

	async createDeleteProposal(
		uri: vscode.Uri,
		options: { openDiff?: boolean; preserveFocus?: boolean } = {}
	): Promise<IBeamProposalChangeSummary> {
		const { text: originalText, exists } = await this.readUriText(uri);
		if (!exists) {
			throw new Error(vscode.l10n.t('{0} 不存在，无法生成删除提议。', getEditorLabel(uri)));
		}

		return this.upsertProposal({
			originalUri: uri,
			targetLabel: getEditorLabel(uri),
			originalText,
			proposedText: '',
			mode: 'delete',
			isNewFile: false,
			applied: false,
			addedLines: 0,
			deletedLines: 0,
			modifiedLines: 0
		}, {
			openDiff: options.openDiff ?? false,
			preserveFocus: options.preserveFocus ?? true
		});
	}

	async acceptActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.applyProposal(proposal);
		this.log(vscode.l10n.t('已接受 {0} 的编辑提议，保留当前修改。', proposal.targetLabel));
		await this.removeProposal(proposal.id, true);
	}

	async rejectActiveProposal(): Promise<void> {
		const proposal = this.getActiveProposalEntry();
		if (!proposal) {
			return;
		}

		await this.revertProposal(proposal);
		this.log(vscode.l10n.t('已拒绝 {0} 的编辑提议。', proposal.targetLabel));
		await this.removeProposal(proposal.id, false);
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
		const proposal = this.proposals.get(id);
		if (!proposal) {
			return '';
		}

		return uri.query === 'original' ? proposal.originalText : proposal.proposedText;
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
		await this.showProposal(nextProposal, { preferDiff: nextProposal.isNewFile });
		this.fireState();
	}

	private async upsertProposal(
		value: Omit<IBeamProposal, 'id' | 'firstChangeLine'>,
		options: { openDiff: boolean; preserveFocus: boolean }
	): Promise<IBeamProposalChangeSummary> {
		const existing = Array.from(this.proposals.values()).find(item => item.originalUri.toString() === value.originalUri.toString());
		const nextId = existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const proposal = this.withDiffMetadata({
			...value,
			id: nextId,
			originalText: existing?.originalText ?? value.originalText,
			isNewFile: existing?.isNewFile ?? value.isNewFile,
			applied: existing?.applied ?? value.applied
		});

		this.proposals.set(nextId, proposal);
		if (!existing) {
			this.proposalOrder.push(nextId);
		}
		this.activeProposalId = nextId;

		const applied = await this.stageProposalIfNeeded(proposal);
		const stagedProposal = this.withDiffMetadata({
			...proposal,
			applied
		});
		this.proposals.set(nextId, stagedProposal);

		await this.showProposal(stagedProposal, {
			preferDiff: options.openDiff,
			preserveFocus: options.preserveFocus
		});
		this.log(vscode.l10n.t('已先修改 {0}，等待用户确认。', value.targetLabel));
		this.fireState();
		return this.toChangeSummary(stagedProposal);
	}

	private async showProposal(
		proposal: IBeamProposal,
		options: { preferDiff: boolean; preserveFocus?: boolean }
	): Promise<void> {
		const originalSnapshotUri = this.getProposalUri(proposal.id, 'original');
		const proposedSnapshotUri = this.getProposalUri(proposal.id, 'proposed');
		this._onDidChange.fire(originalSnapshotUri);
		this._onDidChange.fire(proposedSnapshotUri);

		if (options.preferDiff) {
			await vscode.workspace.openTextDocument(originalSnapshotUri);
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalSnapshotUri,
				proposedSnapshotUri,
				this.getDiffTitle(proposal),
				{ preview: false, preserveFocus: Boolean(options.preserveFocus) }
			);
			return;
		}

		if (proposal.isNewFile && !proposal.applied) {
			const document = await vscode.workspace.openTextDocument(proposedSnapshotUri);
			await vscode.window.showTextDocument(document, {
				preview: false,
				preserveFocus: Boolean(options.preserveFocus)
			});
			return;
		}

		if (proposal.mode === 'delete') {
			await this.showProposal(proposal, { preferDiff: true, preserveFocus: options.preserveFocus });
			return;
		}

		const document = await vscode.workspace.openTextDocument(proposal.originalUri);
		const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: Boolean(options.preserveFocus) });
		const diffRange = this.inlineDiffDecorator.showInlineDiff(editor, proposal.originalText, proposal.proposedText);
		this.proposals.set(proposal.id, this.withDiffMetadata({
			...proposal,
			firstChangeLine: diffRange.firstChangeLine
		}));
		if (diffRange.hasChanges) {
			const line = Math.min(diffRange.firstChangeLine, document.lineCount - 1);
			const range = document.lineAt(Math.max(0, line)).range;
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	private async applyProposal(proposal: IBeamProposal): Promise<void> {
		if (proposal.applied) {
			const activeEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === proposal.originalUri.toString());
			if (activeEditor) {
				this.inlineDiffDecorator.clearDecorations(activeEditor);
			}
			return;
		}

		if (proposal.mode === 'delete') {
			const edit = new vscode.WorkspaceEdit();
			edit.deleteFile(proposal.originalUri, { ignoreIfNotExists: true });
			await vscode.workspace.applyEdit(edit);
			return;
		}

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

	private async revertProposal(proposal: IBeamProposal): Promise<void> {
		if (!proposal.applied) {
			return;
		}

		if (proposal.isNewFile) {
			const edit = new vscode.WorkspaceEdit();
			edit.deleteFile(proposal.originalUri, { ignoreIfNotExists: true });
			await vscode.workspace.applyEdit(edit);
			await this.closeTabsForUri(proposal.originalUri);
			return;
		}

		await this.ensureParentDirectory(proposal.originalUri);
		const exists = await this.uriExists(proposal.originalUri);
		if (!exists) {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(proposal.originalUri, { ignoreIfExists: true });
			if (proposal.originalText.length) {
				edit.insert(proposal.originalUri, new vscode.Position(0, 0), proposal.originalText);
			}
			await vscode.workspace.applyEdit(edit);
		} else {
			const document = await vscode.workspace.openTextDocument(proposal.originalUri);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(proposal.originalUri, fullDocumentRange(document), proposal.originalText);
			await vscode.workspace.applyEdit(edit);
		}

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

		await this.closeTabsForProposal(proposal.id);

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
			await this.showProposal(nextProposal, { preferDiff: nextProposal.isNewFile });
		}
		this.fireState();
	}

	private getActiveProposalEntry(): IBeamProposal | undefined {
		return this.activeProposalId ? this.proposals.get(this.activeProposalId) : undefined;
	}

	private getProposalUri(id: string, kind: 'original' | 'proposed'): vscode.Uri {
		return vscode.Uri.from({
			scheme: PROPOSAL_SCHEME,
			path: `/${id}`,
			query: kind
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

	private async closeAllProposalTabs(): Promise<void> {
		await this.closeMatchingTabs(tab => isBeamProposalTab(tab.input));
	}

	private async closeTabsForProposal(id: string): Promise<void> {
		await this.closeMatchingTabs(tab => isBeamProposalTab(tab.input, id));
	}

	private async closeTabsForUri(uri: vscode.Uri): Promise<void> {
		await this.closeMatchingTabs(tab => isWorkspaceUriTab(tab.input, uri));
	}

	private async closeMatchingTabs(predicate: (tab: vscode.Tab) => boolean): Promise<void> {
		const tabs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(predicate);

		if (!tabs.length) {
			return;
		}

		await vscode.window.tabGroups.close(tabs, true);
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

	private withDiffMetadata(proposal: IBeamProposal): IBeamProposal {
		const summary = summarizeProposalLines(proposal.originalText, proposal.proposedText);
		return {
			...proposal,
			firstChangeLine: summary.firstChangeLine,
			lastChangeLine: summary.lastChangeLine,
			addedLines: summary.addedLines,
			deletedLines: summary.deletedLines,
			modifiedLines: summary.modifiedLines
		};
	}

	private toChangeSummary(proposal: IBeamProposal): IBeamProposalChangeSummary {
		const changeCount = proposal.addedLines + proposal.deletedLines + proposal.modifiedLines;
		const lineLabel = formatLineRangeLabel(proposal.firstChangeLine, proposal.lastChangeLine);
		const statParts: string[] = [];
		if (proposal.addedLines) {
			statParts.push(vscode.l10n.t('+{0} 行', proposal.addedLines));
		}
		if (proposal.deletedLines) {
			statParts.push(vscode.l10n.t('-{0} 行', proposal.deletedLines));
		}
		if (proposal.modifiedLines) {
			statParts.push(vscode.l10n.t('~{0} 行', proposal.modifiedLines));
		}
		const summary = [lineLabel, statParts.join(' ')].filter(Boolean).join(' · ') || vscode.l10n.t('整文件变更');
		return {
			id: proposal.id,
			label: proposal.targetLabel,
			mode: proposal.mode,
			firstChangeLine: proposal.firstChangeLine === undefined ? undefined : proposal.firstChangeLine + 1,
			lastChangeLine: proposal.lastChangeLine === undefined ? undefined : proposal.lastChangeLine + 1,
			addedLines: proposal.addedLines,
			deletedLines: proposal.deletedLines,
			modifiedLines: proposal.modifiedLines,
			changeCount,
			isNewFile: proposal.isNewFile,
			applied: proposal.applied,
			summary
		};
	}

	private async stageProposalIfNeeded(proposal: IBeamProposal): Promise<boolean> {
		if (proposal.mode === 'delete') {
			const edit = new vscode.WorkspaceEdit();
			edit.deleteFile(proposal.originalUri, { ignoreIfNotExists: true });
			await vscode.workspace.applyEdit(edit);
			return true;
		}

		await this.ensureParentDirectory(proposal.originalUri);
		if (!await this.uriExists(proposal.originalUri)) {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(proposal.originalUri, { ignoreIfExists: true });
			if (proposal.proposedText.length) {
				edit.insert(proposal.originalUri, new vscode.Position(0, 0), proposal.proposedText);
			}
			await vscode.workspace.applyEdit(edit);
			return true;
		}

		const document = await vscode.workspace.openTextDocument(proposal.originalUri);
		if (document.getText() !== proposal.proposedText) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(proposal.originalUri, fullDocumentRange(document), proposal.proposedText);
			await vscode.workspace.applyEdit(edit);
		}
		return true;
	}

	private async ensureParentDirectory(uri: vscode.Uri): Promise<void> {
		if (uri.scheme !== 'file') {
			return;
		}

		const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
		try {
			await vscode.workspace.fs.createDirectory(parentUri);
		} catch {
			// Best effort only.
		}
	}
}

function applyProposalText(editor: vscode.TextEditor, code: string, mode: 'replace' | 'insert'): string {
	const document = editor.document;
	return applyProposalTextToContent(
		document.getText(),
		code,
		mode,
		document.offsetAt(editor.selection.active),
		editor.selections.map(selection => ({
			start: document.offsetAt(selection.start),
			end: document.offsetAt(selection.end)
		}))
	);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
	const lastLine = document.lineAt(document.lineCount - 1);
	return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
}

function isBeamProposalTab(input: vscode.Tab['input'], proposalId?: string): boolean {
	const matchesProposal = (uri: vscode.Uri): boolean => uri.scheme === PROPOSAL_SCHEME
		&& (!proposalId || uri.path === `/${proposalId}`);

	if (input instanceof vscode.TabInputText) {
		return matchesProposal(input.uri);
	}

	if (input instanceof vscode.TabInputTextDiff) {
		return matchesProposal(input.original) || matchesProposal(input.modified);
	}

	return false;
}

function isWorkspaceUriTab(input: vscode.Tab['input'], uri: vscode.Uri): boolean {
	if (input instanceof vscode.TabInputText) {
		return input.uri.toString() === uri.toString();
	}

	if (input instanceof vscode.TabInputTextDiff) {
		return input.original.toString() === uri.toString() || input.modified.toString() === uri.toString();
	}

	return false;
}

function summarizeProposalLines(originalText: string, proposedText: string): {
	readonly firstChangeLine?: number;
	readonly lastChangeLine?: number;
	readonly addedLines: number;
	readonly deletedLines: number;
	readonly modifiedLines: number;
} {
	const originalLines = originalText.split('\n');
	const proposedLines = proposedText.split('\n');
	let firstChangeLine: number | undefined;
	let lastChangeLine: number | undefined;
	let addedLines = 0;
	let deletedLines = 0;
	let modifiedLines = 0;

	const maxLines = Math.max(originalLines.length, proposedLines.length);
	for (let index = 0; index < maxLines; index++) {
		const originalLine = originalLines[index];
		const proposedLine = proposedLines[index];

		if (originalLine === undefined && proposedLine !== undefined) {
			firstChangeLine ??= index;
			lastChangeLine = index;
			addedLines += 1;
			continue;
		}

		if (originalLine !== undefined && proposedLine === undefined) {
			firstChangeLine ??= index;
			lastChangeLine = index;
			deletedLines += 1;
			continue;
		}

		if (originalLine !== proposedLine) {
			firstChangeLine ??= index;
			lastChangeLine = index;
			modifiedLines += 1;
		}
	}

	return {
		firstChangeLine,
		lastChangeLine,
		addedLines,
		deletedLines,
		modifiedLines
	};
}

function formatLineRangeLabel(firstLine: number | undefined, lastLine: number | undefined): string | undefined {
	if (firstLine === undefined || lastLine === undefined) {
		return undefined;
	}

	if (firstLine === lastLine) {
		return vscode.l10n.t('第 {0} 行', firstLine + 1);
	}

	return vscode.l10n.t('第 {0}-{1} 行', firstLine + 1, lastLine + 1);
}
