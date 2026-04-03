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
const OUTPUT_CHANNEL_NAME = 'Cursor \u667a\u80fd\u4f53';
const INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.insertCodeBlock';
const REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.replaceSelectionWithCodeBlock';
const PREVIEW_INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.previewInsertCodeBlock';
const PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.previewReplaceSelectionWithCodeBlock';
const ACCEPT_PROPOSAL_COMMAND = 'cursorAgent.acceptProposal';
const REJECT_PROPOSAL_COMMAND = 'cursorAgent.rejectProposal';
const REOPEN_PROPOSAL_COMMAND = 'cursorAgent.reopenProposal';
const ANALYZE_CURRENT_CONTEXT_COMMAND = 'cursorAgent.analyzeCurrentContext';
const SELECT_CURRENT_FUNCTION_COMMAND = 'cursorAgent.selectCurrentFunction';
const SELECT_CURRENT_BLOCK_COMMAND = 'cursorAgent.selectCurrentBlock';
const FOCUS_SELECTION_COMMAND = 'cursorAgent.focusSelection';
const ASK_ABOUT_SELECTION_COMMAND = 'cursorAgent.askAboutSelection';
const ADD_SELECTION_TO_CHAT_COMMAND = 'cursorAgent.addSelectionToChat';
const EDIT_SELECTION_COMMAND = 'cursorAgent.editSelection';
const EXPLAIN_SELECTION_COMMAND = 'cursorAgent.explainSelection';
const FIX_CURRENT_FILE_COMMAND = 'cursorAgent.fixCurrentFile';

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
			composerService.clear();
			proposalService.reset();
			provider.seedPrompt('');
			provider.postState();
			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendSelection', async () => {
			if (!composerService.addSelectionAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u9009\u4e2d\u4e00\u4e9b\u4ee3\u7801\u3002'));
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendCurrentFile', async () => {
			if (!composerService.addCurrentFileAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u4ef6\u3002'));
				return;
			}

			await revealSidebar(provider, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendProblems', async () => {
			if (!composerService.addProblemsAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u5f53\u524d\u6587\u4ef6\u6ca1\u6709\u8bca\u65ad\u4fe1\u606f\u3002'));
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
		vscode.commands.registerCommand(REOPEN_PROPOSAL_COMMAND, async () => {
			await proposalService.reopenActiveProposal();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ANALYZE_CURRENT_CONTEXT_COMMAND, async () => {
			const requestContext = await contextService.buildPromptContext();
			await revealSidebar(provider);
			await service.sendUserMessage(
				vscode.l10n.t('\u8bf7\u5148\u4f7f\u7528\u53ef\u7528\u5de5\u5177\u68c0\u67e5\u5f53\u524d\u4ee3\u7801\u4e0a\u4e0b\u6587\uff0c\u518d\u7ed9\u51fa\u56de\u7b54\u3002\u4f60\u5fc5\u987b\u81f3\u5c11\u8c03\u7528\u4e00\u4e2a\u5de5\u5177\u3002\u5982\u679c\u9700\u8981\u9ad8\u4eae\u76f8\u5173\u8303\u56f4\uff0c\u8bf7\u4f7f\u7528 select_editor_range\u3002\u5982\u679c\u4f60\u5efa\u8bae\u5177\u4f53\u4fee\u6539\uff0c\u8bf7\u521b\u5efa\u7f16\u8f91\u63d0\u8bae\uff0c\u800c\u4e0d\u662f\u53ea\u7c98\u8d34\u4ee3\u7801\u3002\u6700\u540e\u7b80\u8981\u603b\u7ed3\u4f60\u7684\u53d1\u73b0\u3002'),
				requestContext
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_CURRENT_FUNCTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const range = await selectCurrentFunction(editor);
			if (!range) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u51fd\u6570\u6216\u65b9\u6cd5\u3002'));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_CURRENT_BLOCK_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const range = await selectCurrentBlock(editor);
			if (!range) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u53ef\u8bc6\u522b\u7684\u4ee3\u7801\u5757\u3002'));
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
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u9009\u4e2d\u4e00\u4e9b\u4ee3\u7801\u3002'));
				return;
			}

			const prompt = [
				vscode.l10n.t('\u8bf7\u5206\u6790\u8fd9\u6bb5\u9009\u4e2d\u5185\u5bb9\uff0c\u5e76\u5728\u9700\u8981\u65f6\u5148\u8c03\u7528\u5de5\u5177\u518d\u56de\u7b54\u3002'),
			].join('\n');

			composerService.addSelectionAttachment();
			await revealSidebar(provider, true);
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
		vscode.commands.registerCommand(EDIT_SELECTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const selection = getEditorSelectionSnapshot(editor, 1200);
			if (!editor || !selection) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u9009\u4e2d\u4e00\u4e9b\u4ee3\u7801\u3002'));
				return;
			}

			composerService.addSelectionAttachment();
			await revealSidebar(provider, true);
			provider.seedPrompt(vscode.l10n.t('\u8bf7\u4fee\u6539\u8fd9\u6bb5\u9009\u4e2d\u5185\u5bb9\u3002\u9700\u8981\u65f6\u5148\u8c03\u7528\u5de5\u5177\uff1b\u5982\u679c\u8981\u7ed9\u51fa\u5177\u4f53\u6539\u52a8\uff0c\u8bf7\u521b\u5efa\u7f16\u8f91\u63d0\u8bae\uff0c\u800c\u4e0d\u662f\u53ea\u7c98\u8d34\u4ee3\u7801\u3002'));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(EXPLAIN_SELECTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const selection = getEditorSelectionSnapshot(editor, 1200);
			if (!editor || !selection) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u9009\u4e2d\u4e00\u4e9b\u4ee3\u7801\u3002'));
				return;
			}

			composerService.addSelectionAttachment();
			await revealSidebar(provider, true);
			provider.seedPrompt(vscode.l10n.t('\u8bf7\u7b80\u8981\u89e3\u91ca\u8fd9\u6bb5\u9009\u4e2d\u5185\u5bb9\u3002\u53ea\u6709\u5728\u9700\u8981\u7406\u89e3\u5468\u8fb9\u4e0a\u4e0b\u6587\u65f6\u624d\u8c03\u7528\u5de5\u5177\u3002'));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(FIX_CURRENT_FILE_COMMAND, async () => {
			if (!composerService.addCurrentFileAttachment()) {
				void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u4ef6\u3002'));
				return;
			}

			composerService.addProblemsAttachment();
			await revealSidebar(provider, true);
			provider.seedPrompt(vscode.l10n.t('\u8bf7\u68c0\u67e5\u5f53\u524d\u6587\u4ef6\u4e2d\u7684\u95ee\u9898\u5e76\u76f4\u63a5\u7ed9\u51fa\u4fee\u590d\u65b9\u6848\u3002\u5fc5\u8981\u65f6\u5148\u8c03\u7528\u5de5\u5177\uff0c\u5e76\u4f18\u5148\u521b\u5efa\u53ef\u5e94\u7528\u7684\u7f16\u8f91\u63d0\u8bae\u3002'));
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
		void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u672c\u7f16\u8f91\u5668\uff0c\u518d\u5e94\u7528 Cursor \u667a\u80fd\u4f53\u751f\u6210\u7684\u4ee3\u7801\u3002'));
		return;
	}

	if (mode === 'replace' && editor.selections.every(selection => selection.isEmpty)) {
		void vscode.window.showInformationMessage(vscode.l10n.t('\u8bf7\u5148\u5728\u7f16\u8f91\u5668\u4e2d\u9009\u4e2d\u8981\u66ff\u6362\u7684\u4ee3\u7801\u3002'));
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

		const addPart = new vscode.InlayHintLabelPart(vscode.l10n.t('\u52a0\u5165\u5bf9\u8bdd'));
		addPart.tooltip = vscode.l10n.t('\u5c06\u5f53\u524d\u9009\u533a\u9644\u52a0\u5230\u5bf9\u8bdd\u8f93\u5165\u533a\u3002');
		addPart.command = {
			title: vscode.l10n.t('\u52a0\u5165 Cursor \u5bf9\u8bdd'),
			command: ADD_SELECTION_TO_CHAT_COMMAND
		};

		const editPart = new vscode.InlayHintLabelPart(vscode.l10n.t('\u4fee\u6539'));
		editPart.tooltip = vscode.l10n.t('\u9644\u52a0\u5f53\u524d\u9009\u533a\uff0c\u5e76\u76f4\u63a5\u51c6\u5907\u4fee\u6539\u8bf7\u6c42\u3002');
		editPart.command = {
			title: vscode.l10n.t('\u7528 Cursor \u4fee\u6539\u9009\u533a'),
			command: EDIT_SELECTION_COMMAND
		};

		const askPart = new vscode.InlayHintLabelPart(vscode.l10n.t('\u63d0\u95ee'));
		askPart.tooltip = vscode.l10n.t('\u9644\u52a0\u5f53\u524d\u9009\u533a\uff0c\u5e76\u6253\u5f00\u8f93\u5165\u6846\u51c6\u5907\u63d0\u95ee\u3002');
		askPart.command = {
			title: vscode.l10n.t('\u5411 Cursor \u63d0\u95ee'),
			command: ASK_ABOUT_SELECTION_COMMAND
		};

		const explainPart = new vscode.InlayHintLabelPart(vscode.l10n.t('\u89e3\u91ca'));
		explainPart.tooltip = vscode.l10n.t('\u9644\u52a0\u5f53\u524d\u9009\u533a\uff0c\u5e76\u76f4\u63a5\u51c6\u5907\u89e3\u91ca\u8bf7\u6c42\u3002');
		explainPart.command = {
			title: vscode.l10n.t('\u7528 Cursor \u89e3\u91ca\u9009\u533a'),
			command: EXPLAIN_SELECTION_COMMAND
		};

		const hint = new vscode.InlayHint(
			editor.selection.end,
			[
				addPart,
				new vscode.InlayHintLabelPart('  /  '),
				editPart,
				new vscode.InlayHintLabelPart('  /  '),
				askPart
			],
			vscode.InlayHintKind.Type
		);
		hint.paddingLeft = true;
		hint.tooltip = vscode.l10n.t('\u9488\u5bf9\u5f53\u524d\u9009\u4e2d\u4ee3\u7801\u7684 Cursor \u667a\u80fd\u4f53\u5feb\u6377\u5165\u53e3\u3002\u53f3\u952e\u83dc\u5355\u4e2d\u4ecd\u53ef\u4f7f\u7528\u89e3\u91ca\u7b49\u5b8c\u6574\u52a8\u4f5c\u3002');
		return [hint];
	}
}
