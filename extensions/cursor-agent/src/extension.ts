/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CursorAgentService } from './cursorAgentService';
import { CursorContextService } from './cursorContextService';
import { getPreferredCodeEditor } from './editorContext';
import { CursorProposalService } from './cursorProposalService';
import { CursorSidebarProvider } from './cursorSidebarProvider';

const SIDEBAR_VIEW_ID = 'cursorAgent.sidebar';
const VIEW_CONTAINER_ID = 'workbench.view.extension.cursor-agent';
const OUTPUT_CHANNEL_NAME = 'Cursor Agent';
const INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.insertCodeBlock';
const REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.replaceSelectionWithCodeBlock';
const PREVIEW_INSERT_CODE_BLOCK_COMMAND = 'cursorAgent.previewInsertCodeBlock';
const PREVIEW_REPLACE_SELECTION_CODE_BLOCK_COMMAND = 'cursorAgent.previewReplaceSelectionWithCodeBlock';
const ACCEPT_PROPOSAL_COMMAND = 'cursorAgent.acceptProposal';
const REJECT_PROPOSAL_COMMAND = 'cursorAgent.rejectProposal';

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const service = new CursorAgentService(context.workspaceState, outputChannel);
	const contextService = new CursorContextService(context.workspaceState, outputChannel);
	const proposalService = new CursorProposalService(outputChannel);
	const provider = new CursorSidebarProvider(context.extensionUri, service, contextService, proposalService);

	context.subscriptions.push(outputChannel);
	context.subscriptions.push(service);
	context.subscriptions.push(contextService);
	context.subscriptions.push(proposalService);
	context.subscriptions.push(provider);
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
			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendSelection', async () => {
			const editor = getPreferredCodeEditor();
			if (!editor || editor.selection.isEmpty) {
				return;
			}

			const selection = editor.document.getText(editor.selection);
			const language = editor.document.languageId || 'plaintext';
			const startLine = editor.selection.start.line + 1;
			const endLine = editor.selection.end.line + 1;
			const payload = [
				`File: ${editor.document.uri.fsPath || editor.document.uri.toString()}`,
				`Selection: lines ${startLine}-${endLine}`,
				'',
				'```' + language,
				selection,
				'```'
			].join('\n');

			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
			provider.seedPrompt(payload);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendCurrentFile', async () => {
			const editor = getPreferredCodeEditor();
			if (!editor) {
				return;
			}

			const document = editor.document;
			const language = document.languageId || 'plaintext';
			const payload = [
				`Current file: ${document.uri.fsPath || document.uri.toString()}`,
				`Language: ${language}`,
				'',
				'```' + language,
				document.getText(),
				'```'
			].join('\n');

			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
			provider.seedPrompt(payload);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cursorAgent.sendProblems', async () => {
			const editor = getPreferredCodeEditor();
			if (!editor) {
				return;
			}

			const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
			if (!diagnostics.length) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No diagnostics found for the active file.'));
				return;
			}

			const payload = [
				`Diagnostics for: ${editor.document.uri.fsPath || editor.document.uri.toString()}`,
				'',
				...diagnostics.map((diagnostic, index) => {
					const line = diagnostic.range.start.line + 1;
					const column = diagnostic.range.start.character + 1;
					const severity = diagnosticSeverityToString(diagnostic.severity);
					const source = diagnostic.source ? ` (${diagnostic.source})` : '';
					return `${index + 1}. [${severity}] Line ${line}, Column ${column}${source}: ${diagnostic.message}`;
				})
			].join('\n');

			await vscode.commands.executeCommand(VIEW_CONTAINER_ID);
			provider.reveal();
			provider.seedPrompt(payload);
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
}

function diagnosticSeverityToString(severity: vscode.DiagnosticSeverity): string {
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
