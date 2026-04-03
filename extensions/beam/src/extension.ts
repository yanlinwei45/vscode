/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { BeamService } from "./beamService";
import { BeamComposerService } from "./composerService";
import { BeamContextService } from "./contextService";
import {
	getPreferredCodeEditor,
	revealEditorRange,
	selectCurrentBlock,
	selectCurrentFunction,
} from "./editorContext";
import { BeamProposalService } from "./proposalService";
import { PendingChangesTreeProvider } from "./pendingChangesView";
import { BeamSidebarProvider } from "./sidebarProvider";
import { BeamToolService } from "./toolService";

const SIDEBAR_VIEW_ID = "beam.sidebar";
const VIEW_CONTAINER_ID = "workbench.view.extension.beam";
const OUTPUT_CHANNEL_NAME = "Beam";
const INSERT_CODE_BLOCK_COMMAND = "beam.insertCodeBlock";
const REPLACE_SELECTION_CODE_BLOCK_COMMAND =
	"beam.replaceSelectionWithCodeBlock";
const PREVIEW_INSERT_CODE_BLOCK_COMMAND = "beam.previewInsertCodeBlock";
const PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND =
	"beam.previewReplaceSelectionWithCodeBlock";
const ACCEPT_PROPOSAL_COMMAND = "beam.acceptProposal";
const REJECT_PROPOSAL_COMMAND = "beam.rejectProposal";
const REOPEN_PROPOSAL_COMMAND = "beam.reopenProposal";
const OPEN_PROPOSAL_DIFF_COMMAND = "beam.openProposalDiff";
const OPEN_PENDING_CHANGE_COMMAND = "beam.openPendingChange";
const ACCEPT_ALL_CHANGES_COMMAND = "beam.acceptAllChanges";
const REJECT_ALL_CHANGES_COMMAND = "beam.rejectAllChanges";
const ANALYZE_CURRENT_CONTEXT_COMMAND = "beam.analyzeCurrentContext";
const SELECT_CURRENT_FUNCTION_COMMAND = "beam.selectCurrentFunction";
const SELECT_CURRENT_BLOCK_COMMAND = "beam.selectCurrentBlock";
const FOCUS_SELECTION_COMMAND = "beam.focusSelection";
const ASK_ABOUT_SELECTION_COMMAND = "beam.askAboutSelection";
const ADD_SELECTION_TO_CHAT_COMMAND = "beam.addSelectionToChat";
const EDIT_SELECTION_COMMAND = "beam.editSelection";
const EXPLAIN_SELECTION_COMMAND = "beam.explainSelection";
const SELECTION_ACTIONS_COMMAND = "beam.selectionActions";
const FIX_CURRENT_FILE_COMMAND = "beam.fixCurrentFile";
const OPEN_SESSION_COMMAND = "beam.openSession";
const ADD_SELECTION_TO_CHAT_STATUS_COMMAND =
	"beam.addSelectionToChatFromStatus";

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const composerService = new BeamComposerService();
	const contextService = new BeamContextService(
		context.workspaceState,
		outputChannel,
	);
	const proposalService = new BeamProposalService(outputChannel);
	const toolService = new BeamToolService(
		contextService,
		proposalService,
		outputChannel,
	);
	const service = new BeamService(
		context.workspaceState,
		outputChannel,
		toolService,
	);
	const provider = new BeamSidebarProvider(
		context.extensionUri,
		service,
		composerService,
		contextService,
		proposalService,
	);
	const pendingChangesTreeProvider = new PendingChangesTreeProvider();

	context.subscriptions.push(outputChannel);
	context.subscriptions.push(service);
	context.subscriptions.push(composerService);
	context.subscriptions.push(contextService);
	context.subscriptions.push(proposalService);
	context.subscriptions.push(provider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	context.subscriptions.push(
		vscode.window.createTreeView("beam.pendingChanges", {
			treeDataProvider: pendingChangesTreeProvider,
		}),
	);

	// Update tree when proposals change
	proposalService.onDidChangeState(() => {
		const changes = proposalService.getPendingChanges();
		pendingChangesTreeProvider.setChanges(changes);
	});

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.open", async () => {
			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.newChat", async () => {
			service.reset();
			composerService.clear();
			proposalService.reset();
			provider.seedPrompt("");
			provider.postState();
			await revealSidebar(provider, true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			OPEN_SESSION_COMMAND,
			async (sessionId: unknown) => {
				if (typeof sessionId !== "string" || !sessionId) {
					return;
				}

				service.openSession(sessionId);
				composerService.clear();
				proposalService.reset();
				provider.seedPrompt("");
				await revealSidebar(provider, true);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.sendSelection", async () => {
			await handleSelectionAction(composerService, provider);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.sendCurrentFile", async () => {
			const attachment = composerService.addCurrentFileAttachment();
			if (!attachment) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						"\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u4ef6\u3002",
					),
				);
				return;
			}

			await revealSidebar(provider, true);
			provider.showAttachmentAdded(attachment);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.sendProblems", async () => {
			const attachment = composerService.addProblemsAttachment();
			if (!attachment) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						"\u5f53\u524d\u6587\u4ef6\u6ca1\u6709\u8bca\u65ad\u4fe1\u606f\u3002",
					),
				);
				return;
			}

			await revealSidebar(provider, true);
			provider.showAttachmentAdded(attachment);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("beam.showLogs", () => {
			service.showOutput();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			INSERT_CODE_BLOCK_COMMAND,
			async (code: unknown) => {
				if (typeof code !== "string" || !code.length) {
					return;
				}

				await applyCodeToActiveEditor(code, "insert");
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			REPLACE_SELECTION_CODE_BLOCK_COMMAND,
			async (code: unknown) => {
				if (typeof code !== "string" || !code.length) {
					return;
				}

				await applyCodeToActiveEditor(code, "replace");
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			PREVIEW_INSERT_CODE_BLOCK_COMMAND,
			async (code: unknown) => {
				if (typeof code !== "string" || !code.length) {
					return;
				}

				await proposalService.createProposalFromCodeBlock(code, "insert");
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND,
			async (code: unknown) => {
				if (typeof code !== "string" || !code.length) {
					return;
				}

				await proposalService.createProposalFromCodeBlock(code, "replace");
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ACCEPT_PROPOSAL_COMMAND, async () => {
			await proposalService.acceptActiveProposal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REJECT_PROPOSAL_COMMAND, () => {
			proposalService.rejectActiveProposal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REOPEN_PROPOSAL_COMMAND, async () => {
			await proposalService.reopenActiveProposal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(OPEN_PROPOSAL_DIFF_COMMAND, async () => {
			await proposalService.reopenActiveProposal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			OPEN_PENDING_CHANGE_COMMAND,
			async (uri: vscode.Uri) => {
				await proposalService.openPendingChange(uri);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ACCEPT_ALL_CHANGES_COMMAND, async () => {
			while (proposalService.getActiveProposal()) {
				await proposalService.acceptActiveProposal();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(REJECT_ALL_CHANGES_COMMAND, () => {
			while (proposalService.getActiveProposal()) {
				proposalService.rejectActiveProposal();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			ANALYZE_CURRENT_CONTEXT_COMMAND,
			async () => {
				const requestContext = await contextService.buildPromptContext();
				await revealSidebar(provider);
				await service.sendUserMessage(
					vscode.l10n.t(
						"\u8bf7\u5148\u4f7f\u7528\u53ef\u7528\u5de5\u5177\u68c0\u67e5\u5f53\u524d\u4ee3\u7801\u4e0a\u4e0b\u6587\uff0c\u518d\u7ed9\u51fa\u56de\u7b54\u3002\u4f60\u5fc5\u987b\u81f3\u5c11\u8c03\u7528\u4e00\u4e2a\u5de5\u5177\u3002\u5982\u679c\u9700\u8981\u9ad8\u4eae\u76f8\u5173\u8303\u56f4\uff0c\u8bf7\u4f7f\u7528 select_editor_range\u3002\u5982\u679c\u4f60\u5efa\u8bae\u5177\u4f53\u4fee\u6539\uff0c\u8bf7\u521b\u5efa\u7f16\u8f91\u63d0\u8bae\uff0c\u800c\u4e0d\u662f\u53ea\u7c98\u8d34\u4ee3\u7801\u3002\u6700\u540e\u7b80\u8981\u603b\u7ed3\u4f60\u7684\u53d1\u73b0\u3002",
					),
					requestContext,
				);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			SELECT_CURRENT_FUNCTION_COMMAND,
			async () => {
				const editor = getPreferredCodeEditor();
				const range = await selectCurrentFunction(editor);
				if (!range) {
					void vscode.window.showInformationMessage(
						vscode.l10n.t(
							"\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u51fd\u6570\u6216\u65b9\u6cd5\u3002",
						),
					);
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECT_CURRENT_BLOCK_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			const range = await selectCurrentBlock(editor);
			if (!range) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						"\u5f53\u524d\u5149\u6807\u4f4d\u7f6e\u6ca1\u6709\u627e\u5230\u53ef\u8bc6\u522b\u7684\u4ee3\u7801\u5757\u3002",
					),
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(FOCUS_SELECTION_COMMAND, async () => {
			const editor = getPreferredCodeEditor();
			if (!editor) {
				return;
			}

			revealEditorRange(editor);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ASK_ABOUT_SELECTION_COMMAND, async () => {
			await handleSelectionAction(
				composerService,
				provider,
				vscode.l10n.t("继续基于这段选区帮我分析。"),
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(ADD_SELECTION_TO_CHAT_COMMAND, async () => {
			await handleSelectionAction(composerService, provider);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			ADD_SELECTION_TO_CHAT_STATUS_COMMAND,
			async () => {
				await vscode.commands.executeCommand(ADD_SELECTION_TO_CHAT_COMMAND);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(EDIT_SELECTION_COMMAND, async () => {
			await handleSelectionAction(
				composerService,
				provider,
				vscode.l10n.t(
					"帮我修改这段选区；如果需要给出具体改动，请直接创建可应用的编辑提议。",
				),
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(EXPLAIN_SELECTION_COMMAND, async () => {
			await handleSelectionAction(
				composerService,
				provider,
				vscode.l10n.t("帮我解释这段选区在做什么。"),
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(SELECTION_ACTIONS_COMMAND, async () => {
			const choice = await vscode.window.showQuickPick(
				[
					{
						label: vscode.l10n.t('Ask about selection'),
						description: vscode.l10n.t('分析当前选区'),
						command: ASK_ABOUT_SELECTION_COMMAND,
					},
					{
						label: vscode.l10n.t('Edit selection'),
						description: vscode.l10n.t('修改当前选区'),
						command: EDIT_SELECTION_COMMAND,
					},
					{
						label: vscode.l10n.t('Explain selection'),
						description: vscode.l10n.t('解释当前选区'),
						command: EXPLAIN_SELECTION_COMMAND,
					},
					{
						label: vscode.l10n.t('Attach selection to chat'),
						description: vscode.l10n.t('仅附加到对话上下文'),
						command: ADD_SELECTION_TO_CHAT_COMMAND,
					},
				],
				{
					placeHolder: vscode.l10n.t('Choose what to do with the current selection'),
				},
			);
			if (!choice) {
				return;
			}

			await vscode.commands.executeCommand(choice.command);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(FIX_CURRENT_FILE_COMMAND, async () => {
			const fileAttachment = composerService.addCurrentFileAttachment();
			if (!fileAttachment) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						"\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u4ef6\u3002",
					),
				);
				return;
			}

			const problemsAttachment = composerService.addProblemsAttachment();
			await revealSidebar(provider, true);
			provider.showAttachmentAdded(fileAttachment);
			if (problemsAttachment) {
				provider.showAttachmentAdded(problemsAttachment);
			}
			provider.seedPrompt(
				vscode.l10n.t(
					"\u8bf7\u68c0\u67e5\u5f53\u524d\u6587\u4ef6\u4e2d\u7684\u95ee\u9898\u5e76\u76f4\u63a5\u7ed9\u51fa\u4fee\u590d\u65b9\u6848\u3002\u5fc5\u8981\u65f6\u5148\u8c03\u7528\u5de5\u5177\uff0c\u5e76\u4f18\u5148\u521b\u5efa\u53ef\u5e94\u7528\u7684\u7f16\u8f91\u63d0\u8bae\u3002",
				),
			);
		}),
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			[{ scheme: "file" }, { scheme: "untitled" }],
			new BeamProposalCodeLensProvider(proposalService),
		),
	);
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			[{ scheme: "file" }, { scheme: "untitled" }],
			new BeamSelectionCodeLensProvider(proposalService),
		),
	);
}

async function applyCodeToActiveEditor(
	code: string,
	mode: "insert" | "replace",
): Promise<void> {
	const editor = getPreferredCodeEditor();
	if (!editor) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t(
				"\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a\u6587\u672c\u7f16\u8f91\u5668\uff0c\u518d\u5e94\u7528 Beam \u751f\u6210\u7684\u4ee3\u7801\u3002",
			),
		);
		return;
	}

	if (
		mode === "replace" &&
		editor.selections.every((selection) => selection.isEmpty)
	) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t(
				"\u8bf7\u5148\u5728\u7f16\u8f91\u5668\u4e2d\u9009\u4e2d\u8981\u66ff\u6362\u7684\u4ee3\u7801\u3002",
			),
		);
		return;
	}

	await editor.edit((editBuilder) => {
		if (mode === "replace") {
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

async function revealSidebar(
	provider: BeamSidebarProvider,
	focusComposer: boolean = false,
): Promise<void> {
	await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
	provider.reveal();
	if (focusComposer) {
		provider.focusComposer();
	}
}

async function handleSelectionAction(
	composerService: BeamComposerService,
	provider: BeamSidebarProvider,
	promptText?: string,
): Promise<boolean> {
	const attachment = composerService.addSelectionAttachment();
	if (!attachment) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t("\u8bf7\u5148\u9009\u4e2d\u4e00\u4e9b\u4ee3\u7801\u3002"),
		);
		return false;
	}

	await revealSidebar(provider, true);
	provider.showAttachmentAdded(attachment);
	if (promptText) {
		provider.seedPrompt(promptText);
	}
	return true;
}

class BeamProposalCodeLensProvider implements vscode.CodeLensProvider {
	constructor(private readonly proposalService: BeamProposalService) {}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const proposal = this.proposalService.getActiveProposal();
		if (
			!proposal ||
			proposal.originalUri.toString() !== document.uri.toString()
		) {
			return [];
		}

		const firstChangeLine = proposal.firstChangeLine;
		const range = new vscode.Range(firstChangeLine, 0, firstChangeLine, 0);

		return [
			new vscode.CodeLens(range, {
				title: `$(check) ${vscode.l10n.t("接受")}`,
				command: ACCEPT_PROPOSAL_COMMAND,
				tooltip: vscode.l10n.t(
					"接受 Beam 的编辑提议",
				),
			}),
			new vscode.CodeLens(range, {
				title: `$(close) ${vscode.l10n.t("拒绝")}`,
				command: REJECT_PROPOSAL_COMMAND,
				tooltip: vscode.l10n.t(
					"拒绝 Beam 的编辑提议",
				),
			}),
			new vscode.CodeLens(range, {
				title: `$(diff) ${vscode.l10n.t("打开对比视图")}`,
				command: OPEN_PROPOSAL_DIFF_COMMAND,
				tooltip: vscode.l10n.t(
					"在对比视图中查看完整差异",
				),
			}),
		];
	}
}

class BeamSelectionCodeLensProvider
	implements vscode.CodeLensProvider, vscode.Disposable
{
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
	private readonly localDisposables: vscode.Disposable[] = [];

	constructor(private readonly proposalService: BeamProposalService) {
		this.localDisposables.push(
			vscode.window.onDidChangeTextEditorSelection(() =>
				this._onDidChangeCodeLenses.fire(),
			),
		);
		this.localDisposables.push(
			vscode.window.onDidChangeActiveTextEditor(() =>
				this._onDidChangeCodeLenses.fire(),
			),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.localDisposables).dispose();
		this._onDidChangeCodeLenses.dispose();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const editor = getPreferredCodeEditor();
		const proposal = this.proposalService.getActiveProposal();
		if (
			!editor ||
			editor.document.uri.toString() !== document.uri.toString() ||
			editor.selections.length !== 1 ||
			editor.selection.isEmpty ||
			(proposal && proposal.originalUri.toString() === document.uri.toString())
		) {
			return [];
		}

		const line = editor.selection.end.line;
		const range = new vscode.Range(line, 0, line, 0);
		return [
			new vscode.CodeLens(range, {
				title: `$(sparkle) ${vscode.l10n.t("Ask Beam")}`,
				command: ASK_ABOUT_SELECTION_COMMAND,
				tooltip: vscode.l10n.t("带着这段选区直接向 Beam 提问"),
			}),
		];
	}
}
