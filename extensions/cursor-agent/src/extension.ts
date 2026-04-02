/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CursorAgentService } from './cursorAgentService';
import { CursorComposerService } from './cursorComposerService';
import { CursorContextService } from './cursorContextService';
import { getEditorSelectionSnapshot, getPreferredCodeEditor, revealEditorRange, selectCurrentBlock, selectCurrentFunction } from './editorContext';
import { CursorProposalService } from './cursorProposalService';
import { CursorSidebarProvider } from './cursorSidebarProvider';
import { CursorToolService } from './cursorToolService';

const SIDEBAR_VIEW_ID = 'cursorAgent.sidebar';
const VIEW_CONTAINER_ID = 'workbench.view.extension.cursor-agent';
const OUTPUT_CHANNEL_NAME = 'Cursor Agent';
const INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.insertCodeBlock';
const REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.replaceSelectionWithCodeBlock';
const PREVIEW_INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.previewInsertCodeBlock';
const PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.previewReplaceSelectionWithCodeBlock';
const ACCEPT_PROPOSAL_COMMAND = 'cursorAgent.acceptProposal';
const REJECT_PROPOSAL_COMMAND = 'cursorAgent.rejectProposal';
const ANALYZE_CURRENT_CONTEXT_COMMAND = 'cursorAgent.analyzeCurrentContext';
const SELECT_CURRENT_FUNCTION_COMMAND = 'cursorAgent.selectCurrentFunction';
const SELECT_CURRENT_BLOCK_COMMAND = 'cursorAgent.selectCurrentBlock';
const FOCUS_SELECTION_COMMAND = 'cursorAgent.focusSelection';
const ASK_ABOUT_SELECTION_COMMAND = 'cursorAgent.askAboutSelection';
const ADD_SELECTION_TO_CHAT_COMMAND = 'cursorAgent.addSelectionToChat';

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const composerService = new CursorComposerService();
	const contextService = new CursorContextService(context.workspaceState, outputChannel);
	const proposalService = new CursorProposalService(outputChannel);
	const toolService = new CursorToolService(contextService, proposalService, outputChannel);
	const service = new CursorAgentService(context.workspaceState, outputChannel, toolService);
	const provider = new CursorSidebarProvider(context.extensionUri, service, composerService, contextService, proposalService);
	const selectionInlayHintProvider = new CursorSelectionInlayHintProvider();

	context.subscriptions.push(outputChannel);
	context.subscriptions.push(service);
	context.subscriptions.push(composerService);
	context.subscriptions.push(contextService);
	context.subscriptions.push(proposalService);
	context.subscriptions.push(provider);
	context.subscriptions.push(selectionInlayHintProvider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.open', async () => {
			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.newChat', async () => {
			service.reset();
			provider.postState();
			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendSelection', async () => {
			if (!composerService.addSelectionAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select some code first.'));
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendCurrentFile', async () => {
			if (!composerService.addCurrentFileAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Open a file first.'));
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendProblems', async () => {
			if (!composerService.addProblemsAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No diagnostics found for the active file.'));
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.showLogs', () => {
			service.showOutput();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(INSERT_CODE_BLOCK_COMMAND, async (code: unknown) => {
			if (typeof code !== 'string' || !code.length) {
				return;
			}

			await applyCodeToActiveEditor(code, 'insert');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REPLACE_SELECTION_CODE_BLOCK_COMMAND, async (code: unknown) => {
			if (typeof code !== 'string' || !code.length) {
				return;
			}

			await applyCodeToActiveEditor(code, 'replace');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(PREVIEW_INSERT_CODE_BLOCK_COMMAND, async (code: unknown) => {
			if (typeof code !== 'string' || !code.length) {
				return;
			}

			await proposalService.createProposalFromCodeBlock(code, 'insert');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND, async (code: unknown) => {
			if (typeof code !== 'string' || !code.length) {
				return;
			}

			await proposalService.createProposalFromCodeBlock(code, 'replace');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ACCEPT_PROPOSAL_COMMAND, async () => {
			await proposalService.acceptActiveProposal();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REJECT_PROPOSAL_COMMAND, () => {
			proposalService.rejectActiveProposal();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ANALYZE_CURRENT_CONTEXT_COMMAND, async () => {
			const requestContext = await contextService.buildPromptContext();
			await revealSidebar(provider);
			await service.sendUserMessage(
				vscode.l10n.t('Use your available tools to inspect the current code context before answering. You must use at least one tool. If a relevant range should be highlighted, use select_editor_range. If you recommend a concrete code change, create an edit proposal instead of only pasting code. Then summarize your findings briefly.'),
				requestContext
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_CURRENT_FUNCTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const range = await selectCurrentFunction(editor);
			if (!range) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No function or method found at the current cursor.'));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_CURRENT_BLOCK_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const range = await selectCurrentBlock(editor);
			if (!range) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No semantic block found at the current cursor.'));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(FOCUS_SELECTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			if (!editor) {
				return;
			}

			revealEditorRange(editor);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ASK_ABOUT_SELECTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const selection = getEditorSelectionSnapshot(editor, 1200);
			if (!editor || !selection) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select some code first.'));
				return;
			}

			const prompt = [
				vscode.l10n.t('Analyze this selection and use tools if needed before answering.'),
			].join('\n');

			composerService.addSelectionAttachment();
			await revealSidebar(provider);
			provider.seedPrompt(prompt);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ADD_SELECTION_TO_CHAT_COMMAND, async () => {
			if (!composerService.addSelectionAttachment()) {
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.languages.registerInlayHintsProvider(
			[
				{ scheme: 'file' },
				{ scheme: 'untitled' }
			],
			selectionInlayHintProvider
		)
	);
}

async function applyCodeToActiveEditor(code: string, mode: 'insert' | 'replace'): Promise<void> {
	const editor = getPreferredCodeEditor();
	if (!editor) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Open a text editor before applying code from Cursor Agent.'));
		return;
	}

	if (mode === 'replace' && editor.selections.every(selection => selection.isEmpty)) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Select code in the editor before replacing it from Cursor Agent.'));
		return;
	}

	await editor.edit(editBuilder => {
		if (mode === 'replace') {
			for (const selection of editor.selections) {
				if (!selection.isEmpty) {
					editBuilder.replace(selection, code);
				}
			}
			return;
		}

		for (const selection of editor.selections) {
			editBuilder.insert(selection.active, code);
		}
	});
}

async function revealSidebar(provider: CursorSidebarProvider, focusComposer: boolean = false): Promise<void> {
	await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
	provider.reveal();
	if (focusComposer) {
		provider.focusComposer();
	}
}

class CursorSelectionInlayHintProvider extends vscode.Disposable implements vscode.InlayHintsProvider {

	private readonly _onDidChangeInlayHints = new vscode.EventEmitter<void>();
	readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;
	private readonly localDisposables: vscode.Disposable[] = [];

	constructor() {
		super(() => {
			vscode.Disposable.from(...this.localDisposables).dispose();
			this._onDidChangeInlayHints.dispose();
		});

		this.localDisposables.push(vscode.window.onDidChangeTextEditorSelection(() => this._onDidChangeInlayHints.fire()));
		this.localDisposables.push(vscode.window.onDidChangeActiveTextEditor(() => this._onDidChangeInlayHints.fire()));
	}

	provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
		const editor = getPreferredCodeEditor();
		if (!editor || editor.document.uri.toString() !== document.uri.toString() || editor.selection.isEmpty || !range.contains(editor.selection.end)) {
			return [];
		}

		const addPart = new vscode.InlayHintLabelPart(vscode.l10n.t('Add to Chat'));
		addPart.tooltip = vscode.l10n.t('Attach the current selection to Cursor Agent.');
		addPart.command = {
			title: vscode.l10n.t('Add to Cursor Agent'),
			command: ADD_SELECTION_TO_CHAT_COMMAND
		};

		const askPart = new vscode.InlayHintLabelPart(vscode.l10n.t('Ask'));
		askPart.tooltip = vscode.l10n.t('Attach the current selection and prepare a question for Cursor Agent.');
		askPart.command = {
			title: vscode.l10n.t('Ask Cursor Agent'),
			command: ASK_ABOUT_SELECTION_COMMAND
		};

		const hint = new vscode.InlayHint(
			editor.selection.end,
			[
				addPart,
				new vscode.InlayHintLabelPart('  ·  '),
				askPart
			],
			vscode.InlayHintKind.Type
		);
		hint.paddingLeft = true;
		hint.tooltip = vscode.l10n.t('Cursor Agent actions for the selected code.');
		return [hint];
	}
}
