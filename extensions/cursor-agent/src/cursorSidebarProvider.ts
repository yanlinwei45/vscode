/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CursorAgentService } from './cursorAgentService';
import { CursorComposerService } from './cursorComposerService';
import { CursorContextService } from './cursorContextService';
import { CursorProposalService } from './cursorProposalService';

export class CursorSidebarProvider extends vscode.Disposable implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;
	private pendingPrompt: string | undefined;
	private shouldFocusComposer = false;
	private readonly localDisposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly service: CursorAgentService,
		private readonly composerService: CursorComposerService,
		private readonly contextService: CursorContextService,
		private readonly proposalService: CursorProposalService
	) {
		super(() => {
			vscode.Disposable.from(...this.localDisposables).dispose();
		});

		this.localDisposables.push(this.service.onDidChangeState(() => {
			this.postState();
		}));
		this.localDisposables.push(this.composerService.onDidChangeState(() => {
			this.postState();
		}));
		this.localDisposables.push(this.contextService.onDidChangeState(() => {
			this.postState();
		}));
		this.localDisposables.push(this.proposalService.onDidChangeState(() => {
			this.postState();
		}));
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.localDisposables.push(webviewView.webview.onDidReceiveMessage(async message => {
			if (message.type === 'send' && typeof message.prompt === 'string') {
				const requestContext = joinContextBlocks(
					await this.contextService.buildPromptContext(),
					this.composerService.buildAttachmentContext()
				);
				await this.service.sendUserMessage(message.prompt, requestContext);
				this.composerService.clear();
				return;
			}

			if (message.type === 'command' && typeof message.command === 'string') {
				const args = Array.isArray(message.args) ? message.args : [];
				await vscode.commands.executeCommand(message.command, ...args);
				return;
			}

			if (message.type === 'removeAttachment' && typeof message.id === 'string') {
				this.composerService.removeAttachment(message.id);
				return;
			}

			if (message.type === 'clearAttachments') {
				this.composerService.clear();
				return;
			}

			if (message.type === 'resetComposer') {
				this.pendingPrompt = undefined;
				this.shouldFocusComposer = false;
				void this.view?.webview.postMessage({ type: 'resetComposer' });
				return;
			}

			if (message.type === 'ready') {
				this.postState();
				if (this.pendingPrompt) {
					this.view?.show?.(true);
					void this.view?.webview.postMessage({ type: 'seedPrompt', value: this.pendingPrompt });
					this.pendingPrompt = undefined;
				}
				if (this.shouldFocusComposer) {
					void this.view?.webview.postMessage({ type: 'focusComposer' });
					this.shouldFocusComposer = false;
				}
			}
		}));
	}

	reveal(): void {
		this.view?.show?.(true);
	}

	seedPrompt(prompt: string): void {
		if (this.view) {
			void this.view.webview.postMessage({ type: 'seedPrompt', value: prompt });
			this.view.show?.(true);
			return;
		}

		this.pendingPrompt = prompt;
	}

	focusComposer(): void {
		if (this.view) {
			void this.view.webview.postMessage({ type: 'focusComposer' });
			return;
		}

		this.shouldFocusComposer = true;
	}

	postState(): void {
		if (!this.view) {
			return;
		}

		void this.view.webview.postMessage({
			type: 'state',
			value: {
				chat: this.service.getState(),
				composer: this.composerService.getState(),
				context: this.contextService.getState(),
				proposal: this.proposalService.getState()
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = createNonce();
		const title = vscode.l10n.t('\u72ec\u7acb\u7f16\u7801\u667a\u80fd\u4f53');
		const subtitle = vscode.l10n.t('\u4e0e VS Code \u5185\u7f6e\u804a\u5929\u5b8c\u5168\u5206\u79bb\uff0c\u76f4\u63a5\u8fde\u63a5\u4f60\u7684 Anthropic \u517c\u5bb9\u63a5\u53e3\u3002');
		const placeholder = vscode.l10n.t('\u8f93\u5165\u9700\u6c42\uff0c\u6bd4\u5982\uff1a\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\u3001\u4fee\u590d\u9519\u8bef\u3001\u91cd\u6784\u5f53\u524d\u6587\u4ef6...');
		const hint = vscode.l10n.t('\u4f7f\u7528 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN \u4e0e ANTHROPIC_BASE_URL\u3002');
		const emptyState = vscode.l10n.t('\u5728\u8fd9\u91cc\u5f00\u542f\u4e00\u6bb5\u65b0\u7684\u7f16\u7801\u5bf9\u8bdd\u3002\u5b83\u4e0d\u4f1a\u66ff\u6362\u6216\u4fee\u6539 VS Code \u81ea\u5e26\u804a\u5929\u3002');
		const send = vscode.l10n.t('\u53d1\u9001');
		const thinking = vscode.l10n.t('\u601d\u8003\u4e2d...');
		const insertLabel = vscode.l10n.t('\u76f4\u63a5\u63d2\u5165');
		const replaceLabel = vscode.l10n.t('\u76f4\u63a5\u66ff\u6362');
		const previewInsertLabel = vscode.l10n.t('\u9884\u89c8\u63d2\u5165');
		const previewReplaceLabel = vscode.l10n.t('\u9884\u89c8\u66ff\u6362');
		const autoContextTitle = vscode.l10n.t('\u5b9e\u65f6\u4e0a\u4e0b\u6587');
		const proposalTitle = vscode.l10n.t('\u7f16\u8f91\u63d0\u8bae');
		const acceptLabel = vscode.l10n.t('\u63a5\u53d7');
		const rejectLabel = vscode.l10n.t('\u62d2\u7edd');
		const reopenProposalLabel = vscode.l10n.t('\u91cd\u65b0\u6253\u5f00\u5bf9\u6bd4');
		const analyzeLabel = vscode.l10n.t('\u5206\u6790\u4e0a\u4e0b\u6587');
		const newChat = vscode.l10n.t('\u65b0\u5efa\u5bf9\u8bdd');
		const attachmentsTitle = vscode.l10n.t('\u9644\u52a0\u4e0a\u4e0b\u6587');
		const attachmentsEmpty = vscode.l10n.t('\u53ef\u4ee5\u628a\u9009\u533a\u3001\u6587\u4ef6\u548c\u95ee\u9898\u4ee5\u7d27\u51d1\u6807\u7b7e\u7684\u5f62\u5f0f\u9644\u52a0\u5230\u8fd9\u91cc\u3002');
		const attachmentsPeekEmpty = vscode.l10n.t('\u70b9\u9009\u4efb\u610f\u9644\u52a0\u9879\u540e\uff0c\u53ef\u4ee5\u5728\u8fd9\u91cc\u5feb\u901f\u9884\u89c8\u3002');
		const addSelectionLabel = vscode.l10n.t('\u6dfb\u52a0\u9009\u533a');
		const addFileLabel = vscode.l10n.t('\u6dfb\u52a0\u6587\u4ef6');
		const addProblemsLabel = vscode.l10n.t('\u6dfb\u52a0\u95ee\u9898');
		const quickExplainLabel = vscode.l10n.t('\u89e3\u91ca\u9009\u533a');
		const quickEditLabel = vscode.l10n.t('\u4fee\u6539\u9009\u533a');
		const quickFixLabel = vscode.l10n.t('\u4fee\u590d\u95ee\u9898');
		const modeAskLabel = vscode.l10n.t('\u63d0\u95ee');
		const modeEditLabel = vscode.l10n.t('\u4fee\u6539');
		const modeFixLabel = vscode.l10n.t('\u4fee\u590d');
		const instantSendLabel = vscode.l10n.t('\u76f4\u63a5\u53d1\u9001');
		const attachedCountLabel = vscode.l10n.t('\u5df2\u9644\u52a0 {0} \u9879');
		const toolSummaryLabel = vscode.l10n.t('\u540e\u53f0\u6267\u884c');
		const toolDetailsLabel = vscode.l10n.t('\u5c55\u5f00\u8be6\u60c5');
		const toolCollapseLabel = vscode.l10n.t('\u6536\u8d77\u8be6\u60c5');
		const toolCountLabel = vscode.l10n.t('\u5171 {0} \u6b65');
		const attachmentPeekTitle = vscode.l10n.t('\u5185\u5bb9\u9884\u89c8');
		const attachmentUseLabel = vscode.l10n.t('\u52a0\u5165\u8f93\u5165\u6846');
		const attachmentInsertSummaryLabel = vscode.l10n.t('\u63d2\u5165\u6458\u8981');
		const clearAttachmentsLabel = vscode.l10n.t('\u6e05\u7a7a\u9644\u52a0');
		const composerReadyLabel = vscode.l10n.t('\u53ef\u76f4\u63a5\u53d1\u9001\uff0c\u4e5f\u53ef\u4ee5\u8865\u4e00\u53e5\u8bf4\u660e\u3002');
		const composerBusyLabel = vscode.l10n.t('\u540e\u53f0\u6b63\u5728\u8c03\u7528\u5de5\u5177\u4e0e\u6574\u7406\u7ed3\u679c\u3002');
		const composerEnterHintLabel = vscode.l10n.t('Enter \u53d1\u9001\uff0cShift+Enter \u6362\u884c');
		const runningToolLabel = vscode.l10n.t('\u6b63\u5728\u5904\u7406\uff1a{0}');
		const proposalHintLabel = vscode.l10n.t('\u6709\u53ef\u5e94\u7528\u7684\u6539\u52a8\u63d0\u8bae\uff0c\u5efa\u8bae\u5148\u9884\u89c8\u518d\u51b3\u5b9a\u3002');
		const proposalInsertModeLabel = vscode.l10n.t('\u63d2\u5165');
		const proposalReplaceModeLabel = vscode.l10n.t('\u66ff\u6362');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Cursor \u667a\u80fd\u4f53</title>
	<style>
		:root {
			color-scheme: light dark;
		}
		body {
			margin: 0;
			font-family: var(--vscode-font-family);
			background: var(--vscode-sideBar-background);
			color: var(--vscode-sideBar-foreground);
		}
		.shell {
			display: flex;
			flex-direction: column;
			height: 100vh;
			background:
				radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-button-background) 20%, transparent), transparent 28%),
				var(--vscode-sideBar-background);
		}
		.header {
			padding: 12px 14px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-button-background) 24%, transparent), transparent 65%);
		}
		.meta {
			padding: 10px 14px 0;
			display: grid;
			gap: 8px;
		}
		.badges {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.card {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 16px;
			padding: 12px 13px;
			background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
			box-shadow: 0 10px 24px rgba(0, 0, 0, 0.05);
		}
		.badge {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 999px;
			padding: 5px 9px;
			font-size: 11px;
			opacity: 0.9;
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
		}
		.proposal {
			background:
				linear-gradient(135deg, color-mix(in srgb, var(--vscode-button-background) 12%, transparent), transparent 68%),
				color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
			display: none;
		}
		.proposal.active {
			display: block;
		}
		.proposal-meta {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: wrap;
			margin-bottom: 8px;
		}
		.proposal-pill {
			border-radius: 999px;
			padding: 4px 8px;
			font-size: 11px;
			font-weight: 700;
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 35%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
		}
		.proposal-hint {
			font-size: 11px;
			opacity: 0.76;
		}
		.attachments-card {
			display: grid;
			gap: 8px;
			padding: 10px;
		}
		.attachments-card.empty {
			opacity: 0.78;
		}
		.attachments-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}
		.attachments-head-actions {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
		.attachment-list {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.attachment {
			border-radius: 999px;
			padding: 7px 10px 7px 11px;
			border: 1px solid var(--vscode-panel-border);
			display: flex;
			align-items: center;
			gap: 7px;
			background: color-mix(in srgb, var(--vscode-button-background) 10%, transparent);
			max-width: 100%;
			cursor: pointer;
			transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
		}
		.attachment:hover {
			transform: translateY(-1px);
			border-color: color-mix(in srgb, var(--vscode-button-background) 42%, var(--vscode-panel-border));
		}
		.attachment.active {
			background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
			border-color: color-mix(in srgb, var(--vscode-button-background) 55%, var(--vscode-panel-border));
		}
		.attachment-kind {
			border-radius: 999px;
			padding: 3px 7px;
			font-size: 11px;
			background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 26%, var(--vscode-panel-border));
			opacity: 0.92;
		}
		.attachment-label {
			font-size: 12px;
			font-weight: 700;
			max-width: 180px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.attachment-preview {
			font-size: 11px;
			opacity: 0.66;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 220px;
		}
		.attachment-main {
			display: grid;
			gap: 2px;
			min-width: 0;
		}
		.attachment-peek {
			display: none;
			border: 1px dashed var(--vscode-panel-border);
			border-radius: 14px;
			padding: 10px 11px;
			background: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
		}
		.attachment-peek.active {
			display: block;
		}
		.attachment-peek-title {
			font-size: 11px;
			font-weight: 700;
			margin-bottom: 6px;
			opacity: 0.76;
		}
		.attachment-peek-body {
			font-size: 12px;
			line-height: 1.55;
			white-space: pre-wrap;
			max-height: 120px;
			overflow: auto;
		}
		.attachment-peek-actions {
			display: flex;
			gap: 8px;
			margin-top: 8px;
			flex-wrap: wrap;
		}
		.attachment-peek-actions button {
			padding: 6px 10px;
			font-size: 11px;
		}
		.attachment-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.attachment-actions button {
			padding: 6px 10px;
			font-size: 11px;
		}
		.attachment-remove {
			border: 0;
			padding: 0;
			width: 18px;
			height: 18px;
			border-radius: 999px;
			background: transparent;
			color: inherit;
			font-size: 13px;
			line-height: 18px;
			cursor: pointer;
			flex: 0 0 auto;
		}
		.proposal-title {
			font-size: 12px;
			font-weight: 700;
			margin-bottom: 6px;
		}
		.proposal-body {
			font-size: 12px;
			line-height: 1.5;
			opacity: 0.85;
		}
		.proposal-actions {
			display: flex;
			gap: 8px;
			margin-top: 10px;
		}
		.proposal-actions button {
			padding: 7px 10px;
			font-size: 12px;
		}
		.section-label {
			font-size: 12px;
			font-weight: 700;
			margin-bottom: 6px;
		}
		.eyebrow {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			opacity: 0.7;
			margin-bottom: 6px;
		}
		.title {
			font-size: 17px;
			font-weight: 700;
		}
		.subtitle {
			margin-top: 4px;
			font-size: 11px;
			opacity: 0.7;
			line-height: 1.45;
		}
		.toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 10px;
		}
		.ghost {
			border: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
			color: inherit;
			padding: 6px 10px;
			font-size: 12px;
			border-radius: 999px;
		}
		.messages {
			flex: 1;
			overflow: auto;
			padding: 14px;
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.message.pending {
			opacity: 0.9;
			box-shadow: none;
			background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
			border-style: dashed;
		}
		.empty {
			padding: 14px;
			border: 1px dashed var(--vscode-panel-border);
			border-radius: 12px;
			opacity: 0.8;
			line-height: 1.5;
		}
		.message {
			padding: 12px 13px;
			border-radius: 16px;
			border: 1px solid var(--vscode-panel-border);
			line-height: 1.5;
			font-size: 13px;
			box-shadow: 0 10px 20px rgba(0, 0, 0, 0.05);
		}
		.message.user {
			background: color-mix(in srgb, var(--vscode-button-background) 16%, transparent);
		}
		.message.assistant {
			background: color-mix(in srgb, var(--vscode-editor-background) 78%, var(--vscode-sideBar-background));
		}
		.message.tool {
			background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent);
			border-style: solid;
			box-shadow: none;
			position: relative;
			opacity: 0.84;
			padding: 10px 11px;
		}
		.message.tool::before {
			content: '';
			position: absolute;
			inset: 0 auto 0 0;
			width: 3px;
			border-radius: 14px 0 0 14px;
			background: color-mix(in srgb, var(--vscode-textLink-foreground) 70%, transparent);
		}
		.message.error {
			border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, var(--vscode-panel-border));
		}
		.role {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			opacity: 0.65;
			margin-bottom: 8px;
		}
		.tool-summary {
			font-size: 12px;
			font-weight: 700;
		}
		.tool-line {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
		.tool-count {
			font-size: 11px;
			opacity: 0.72;
		}
		.tool-chip-list {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			margin-top: 8px;
		}
		.tool-chip {
			border-radius: 999px;
			padding: 4px 8px;
			font-size: 11px;
			border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 26%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent);
		}
		.tool-details {
			margin-top: 6px;
		}
		.tool-details summary {
			cursor: pointer;
			font-size: 11px;
			opacity: 0.7;
		}
		.tool-detail-item {
			padding-top: 8px;
			margin-top: 8px;
			border-top: 1px dashed color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
		}
		.tool-detail-title {
			font-size: 11px;
			font-weight: 700;
			margin-bottom: 6px;
			opacity: 0.82;
		}
		.content {
			display: grid;
			gap: 10px;
		}
		.content p {
			margin: 0;
			white-space: pre-wrap;
		}
		.content pre {
			margin: 0;
			padding: 12px;
			border-radius: 12px;
			overflow: auto;
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, black 12%);
			border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
		}
		.content code {
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
			font-size: 12px;
		}
		.code-actions {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			margin-top: 8px;
		}
		.code-actions button {
			padding: 6px 10px;
			font-size: 11px;
		}
		.composer {
			padding: 12px;
			border-top: 1px solid var(--vscode-panel-border);
			display: grid;
			gap: 10px;
			background: var(--vscode-editor-background);
		}
		.composer-top {
			display: grid;
			gap: 8px;
		}
		.quick-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.quick-actions button {
			padding: 7px 11px;
			font-size: 11px;
		}
		.mode-bar {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: wrap;
		}
		.mode-pill {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 999px;
			padding: 6px 10px;
			font-size: 11px;
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
			cursor: pointer;
		}
		.mode-pill.active {
			background: color-mix(in srgb, var(--vscode-button-background) 22%, transparent);
			border-color: color-mix(in srgb, var(--vscode-button-background) 45%, var(--vscode-panel-border));
		}
		.composer-meta {
			display: flex;
			align-items: center;
			gap: 8px;
			justify-content: space-between;
			flex-wrap: wrap;
		}
		.attachment-count {
			font-size: 11px;
			opacity: 0.72;
		}
		.link-button {
			border: 0;
			padding: 0;
			background: transparent;
			color: var(--vscode-textLink-foreground);
			font-size: 11px;
			font-weight: 600;
			cursor: pointer;
		}
		.composer-shell {
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			border-radius: 18px;
			background: var(--vscode-input-background);
			overflow: hidden;
		}
		textarea {
			width: 100%;
			min-height: 104px;
			resize: vertical;
			box-sizing: border-box;
			border: 0;
			background: transparent;
			color: var(--vscode-input-foreground);
			padding: 12px 13px;
			font: inherit;
			outline: none;
		}
		button {
			border: 0;
			border-radius: 999px;
			padding: 10px 14px;
			font: inherit;
			font-weight: 600;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
		}
		button[disabled] {
			opacity: 0.5;
			cursor: default;
		}
		.actions {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 10px;
			flex-wrap: wrap;
		}
		.hint {
			font-size: 11px;
			opacity: 0.7;
			max-width: 52%;
		}
		.status {
			font-size: 11px;
			opacity: 0.75;
			text-align: right;
			margin-left: auto;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="header">
			<div class="eyebrow">Cursor</div>
			<div class="title">${escapeHtml(title)}</div>
			<div class="subtitle">${escapeHtml(subtitle)}</div>
			<div class="toolbar">
				<button class="ghost" data-command="cursorAgent.analyzeCurrentContext">${escapeHtml(analyzeLabel)}</button>
				<button class="ghost" data-command="cursorAgent.newChat">${escapeHtml(newChat)}</button>
			</div>
		</div>
		<div class="meta">
			<div>
				<div class="section-label">${escapeHtml(autoContextTitle)}</div>
				<div id="contextBadges" class="badges"></div>
			</div>
		</div>
		<div id="messages" class="messages"></div>
		<div class="composer">
			<div id="proposal" class="card proposal">
				<div class="proposal-title">${escapeHtml(proposalTitle)}</div>
				<div class="proposal-meta">
					<div id="proposalMode" class="proposal-pill"></div>
					<div class="proposal-hint">${escapeHtml(proposalHintLabel)}</div>
				</div>
				<div id="proposalBody" class="proposal-body"></div>
				<div class="proposal-actions">
					<button id="reopenProposal" class="ghost">${escapeHtml(reopenProposalLabel)}</button>
					<button id="acceptProposal">${escapeHtml(acceptLabel)}</button>
					<button id="rejectProposal">${escapeHtml(rejectLabel)}</button>
				</div>
			</div>
			<div class="composer-top">
				<div class="quick-actions">
					<button class="ghost" data-seed=${JSON.stringify(vscode.l10n.t('\u8bf7\u89e3\u91ca\u5f53\u524d\u9009\u533a\uff0c\u5e76\u5728\u5fc5\u8981\u65f6\u7ed3\u5408\u4e0a\u4e0b\u6587\u8bf4\u660e\u3002'))}>${escapeHtml(quickExplainLabel)}</button>
					<button class="ghost" data-seed=${JSON.stringify(vscode.l10n.t('\u8bf7\u4fee\u6539\u5f53\u524d\u9009\u533a\uff0c\u5e76\u4f18\u5148\u7ed9\u51fa\u53ef\u5e94\u7528\u7684\u7f16\u8f91\u63d0\u8bae\u3002'))}>${escapeHtml(quickEditLabel)}</button>
					<button class="ghost" data-command="cursorAgent.fixCurrentFile">${escapeHtml(quickFixLabel)}</button>
				</div>
				<div id="attachmentsCard" class="card attachments-card empty">
					<div class="attachments-head">
						<div class="section-label">${escapeHtml(attachmentsTitle)}</div>
						<div class="attachments-head-actions">
							<div id="attachmentCount" class="attachment-count"></div>
							<button id="clearAttachments" class="link-button">${escapeHtml(clearAttachmentsLabel)}</button>
						</div>
					</div>
					<div id="attachmentList" class="attachment-list"></div>
					<pre id="attachmentsEmpty" class="attachment-preview">${escapeHtml(attachmentsEmpty)}</pre>
					<div id="attachmentPeek" class="attachment-peek">
						<div class="attachment-peek-title">${escapeHtml(attachmentPeekTitle)}</div>
						<div id="attachmentPeekBody" class="attachment-peek-body">${escapeHtml(attachmentsPeekEmpty)}</div>
						<div class="attachment-peek-actions">
							<button id="attachmentUse">${escapeHtml(attachmentUseLabel)}</button>
							<button id="attachmentInsertSummary" class="ghost">${escapeHtml(attachmentInsertSummaryLabel)}</button>
						</div>
					</div>
					<div class="attachment-actions">
						<button class="ghost" data-command="cursorAgent.sendSelection">${escapeHtml(addSelectionLabel)}</button>
						<button class="ghost" data-command="cursorAgent.sendCurrentFile">${escapeHtml(addFileLabel)}</button>
						<button class="ghost" data-command="cursorAgent.sendProblems">${escapeHtml(addProblemsLabel)}</button>
					</div>
				</div>
			</div>
			<div class="composer-meta">
				<div class="mode-bar">
					<button class="mode-pill active" data-mode="ask">${escapeHtml(modeAskLabel)}</button>
					<button class="mode-pill" data-mode="edit">${escapeHtml(modeEditLabel)}</button>
					<button class="mode-pill" data-mode="fix">${escapeHtml(modeFixLabel)}</button>
				</div>
				<div id="composerReady" class="attachment-count">${escapeHtml(composerReadyLabel)}</div>
			</div>
			<div class="composer-shell">
				<textarea id="prompt" placeholder="${escapeHtml(placeholder)}"></textarea>
			</div>
			<div class="actions">
				<div class="hint">${escapeHtml(hint)} \u00b7 ${escapeHtml(composerEnterHintLabel)}</div>
				<div class="status" id="status"></div>
				<button id="instantSend" class="ghost">${escapeHtml(instantSendLabel)}</button>
				<button id="send">${escapeHtml(send)}</button>
			</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const promptEl = document.getElementById('prompt');
		const sendEl = document.getElementById('send');
		const instantSendEl = document.getElementById('instantSend');
		const statusEl = document.getElementById('status');
		const attachmentListEl = document.getElementById('attachmentList');
		const attachmentsCardEl = document.getElementById('attachmentsCard');
		const attachmentsEmptyEl = document.getElementById('attachmentsEmpty');
		const attachmentCountEl = document.getElementById('attachmentCount');
		const attachmentPeekEl = document.getElementById('attachmentPeek');
		const attachmentPeekBodyEl = document.getElementById('attachmentPeekBody');
		const attachmentUseEl = document.getElementById('attachmentUse');
		const attachmentInsertSummaryEl = document.getElementById('attachmentInsertSummary');
		const clearAttachmentsEl = document.getElementById('clearAttachments');
		const contextBadgesEl = document.getElementById('contextBadges');
		const proposalEl = document.getElementById('proposal');
		const proposalBodyEl = document.getElementById('proposalBody');
		const proposalModeEl = document.getElementById('proposalMode');
		const reopenProposalEl = document.getElementById('reopenProposal');
		const acceptProposalEl = document.getElementById('acceptProposal');
		const rejectProposalEl = document.getElementById('rejectProposal');
		const composerReadyEl = document.getElementById('composerReady');
		const insertCommand = 'cursorAgent.insertCodeBlock';
		const replaceCommand = 'cursorAgent.replaceSelectionWithCodeBlock';
		const previewInsertCommand = 'cursorAgent.previewInsertCodeBlock';
		const previewReplaceCommand = 'cursorAgent.previewReplaceSelectionWithCodeBlock';
		const modeSeeds = {
			ask: '',
			edit: ${JSON.stringify(vscode.l10n.t('\u8bf7\u6839\u636e\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u76f4\u63a5\u8fdb\u884c\u4fee\u6539\uff0c\u5e76\u4f18\u5148\u7ed9\u51fa\u53ef\u5e94\u7528\u7684\u7f16\u8f91\u63d0\u8bae\u3002'))},
			fix: ${JSON.stringify(vscode.l10n.t('\u8bf7\u6839\u636e\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u6392\u67e5\u95ee\u9898\u5e76\u4fee\u590d\uff0c\u5fc5\u8981\u65f6\u5148\u8c03\u7528\u5de5\u5177\uff0c\u518d\u521b\u5efa\u53ef\u5e94\u7528\u7684\u7f16\u8f91\u63d0\u8bae\u3002'))}
		};
		let state = { chat: { messages: [], busy: false }, composer: { attachments: [] }, context: { summary: [] }, proposal: { active: false } };
		let mode = 'ask';
		let activeAttachmentId = null;
		let seededMode = null;
		const toolLabels = {
			get_active_editor_context: ${JSON.stringify(vscode.l10n.t('\u8bfb\u53d6\u5f53\u524d\u4e0a\u4e0b\u6587'))},
			read_file: ${JSON.stringify(vscode.l10n.t('\u8bfb\u53d6\u6587\u4ef6'))},
			list_directory: ${JSON.stringify(vscode.l10n.t('\u5217\u51fa\u76ee\u5f55'))},
			search_workspace: ${JSON.stringify(vscode.l10n.t('\u641c\u7d22\u5de5\u4f5c\u533a'))},
			get_diagnostics: ${JSON.stringify(vscode.l10n.t('\u83b7\u53d6\u8bca\u65ad\u4fe1\u606f'))},
			open_file: ${JSON.stringify(vscode.l10n.t('\u6253\u5f00\u6587\u4ef6'))},
			select_editor_range: ${JSON.stringify(vscode.l10n.t('\u9009\u4e2d\u8303\u56f4'))},
			select_current_function: ${JSON.stringify(vscode.l10n.t('\u9009\u4e2d\u5f53\u524d\u51fd\u6570'))},
			select_current_block: ${JSON.stringify(vscode.l10n.t('\u6269\u5c55\u5f53\u524d\u4ee3\u7801\u5757'))},
			reveal_range: ${JSON.stringify(vscode.l10n.t('\u5b9a\u4f4d\u8303\u56f4'))},
			create_edit_proposal: ${JSON.stringify(vscode.l10n.t('\u521b\u5efa\u7f16\u8f91\u63d0\u8bae'))},
			write_file: ${JSON.stringify(vscode.l10n.t('\u5199\u5165\u6587\u4ef6'))},
			create_file: ${JSON.stringify(vscode.l10n.t('\u521b\u5efa\u6587\u4ef6'))},
			replace_in_file: ${JSON.stringify(vscode.l10n.t('\u66ff\u6362\u6587\u4ef6\u5185\u5bb9'))},
			run_command: ${JSON.stringify(vscode.l10n.t('\u6267\u884c\u547d\u4ee4'))}
		};
		const attachmentKindLabels = {
			selection: ${JSON.stringify(vscode.l10n.t('\u9009\u533a'))},
			file: ${JSON.stringify(vscode.l10n.t('\u6587\u4ef6'))},
			problems: ${JSON.stringify(vscode.l10n.t('\u95ee\u9898'))}
		};

		function createCodeActions(code) {
			const actions = document.createElement('div');
			actions.className = 'code-actions';

			const previewInsert = document.createElement('button');
			previewInsert.textContent = ${JSON.stringify(previewInsertLabel)};
			previewInsert.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: previewInsertCommand, args: [code] });
			});
			actions.appendChild(previewInsert);

			const previewReplace = document.createElement('button');
			previewReplace.textContent = ${JSON.stringify(previewReplaceLabel)};
			previewReplace.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: previewReplaceCommand, args: [code] });
			});
			actions.appendChild(previewReplace);

			const insert = document.createElement('button');
			insert.textContent = ${JSON.stringify(insertLabel)};
			insert.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: insertCommand, args: [code] });
			});
			actions.appendChild(insert);

			const replace = document.createElement('button');
			replace.textContent = ${JSON.stringify(replaceLabel)};
			replace.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: replaceCommand, args: [code] });
			});
			actions.appendChild(replace);

			return actions;
		}

		function createToolDisplayItems(messages) {
			const displayItems = [];
			for (const message of messages) {
				if (message.role !== 'tool') {
					displayItems.push({ type: 'message', message });
					continue;
				}

				const previous = displayItems[displayItems.length - 1];
				if (previous && previous.type === 'toolGroup') {
					previous.messages.push(message);
					continue;
				}

				displayItems.push({ type: 'toolGroup', messages: [message] });
			}

			return displayItems;
		}

		function createPendingToolDisplayItem() {
			const pendingToolNames = state.chat.pendingToolNames || [];
			const labels = pendingToolNames
				.map(name => toolLabels[name] || name)
				.filter(Boolean);
			return {
				type: 'pending',
				label: ${JSON.stringify(runningToolLabel)}.replace('{0}', labels.length ? labels.join('\u3001') : ${JSON.stringify(vscode.l10n.t('\u51c6\u5907\u4e2d'))})
			};
		}

		function getAttachmentById(id) {
			return (state.composer.attachments || []).find(attachment => attachment.id === id);
		}

		function ensureActiveAttachment() {
			const attachments = state.composer.attachments || [];
			if (!attachments.length) {
				activeAttachmentId = null;
				return null;
			}

			if (!activeAttachmentId || !attachments.some(attachment => attachment.id === activeAttachmentId)) {
				activeAttachmentId = attachments[0].id;
			}

			return getAttachmentById(activeAttachmentId);
		}

		function appendAttachmentToPrompt(attachment, includePreview) {
			if (!attachment) {
				return;
			}

			const label = attachmentKindLabels[attachment.kind] || attachment.kind;
			const block = includePreview
				? '\u3010' + label + '\u3011' + attachment.label + '\\n' + attachment.detail + '\\n' + attachment.preview
				: '[@' + label + ': ' + attachment.label + ']';
			const normalized = promptEl.value.trimEnd();
			promptEl.value = normalized ? normalized + '\\n' + block : block;
			promptEl.focus();
			promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
		}

		function renderContent(container, text, includeCodeActions) {
			const fence = String.fromCharCode(96, 96, 96);
			const parts = text.split(fence);
			for (let i = 0; i < parts.length; i++) {
				if (!parts[i]) {
					continue;
				}

				if (i % 2 === 1) {
					const pre = document.createElement('pre');
					const code = document.createElement('code');
					const normalized = parts[i].replace(/^\\n+|\\n+$/g, '');
					const lines = normalized.split('\\n');
					const firstLine = lines[0] ?? '';
					const body = /^[a-z0-9_+#.-]+$/i.test(firstLine) ? lines.slice(1).join('\\n') : normalized;
					code.textContent = body;
					pre.appendChild(code);
					container.appendChild(pre);
					if (includeCodeActions) {
						container.appendChild(createCodeActions(body));
					}
					continue;
				}

				const paragraphs = parts[i].split(/\\n{2,}/g).filter(Boolean);
				for (const paragraph of paragraphs) {
					const p = document.createElement('p');
					p.textContent = paragraph;
					container.appendChild(p);
				}
			}
		}

		function renderToolGroup(container, messages) {
			const header = document.createElement('div');
			header.className = 'tool-line';

			const summary = document.createElement('div');
			summary.className = 'tool-summary';
			summary.textContent = ${JSON.stringify(toolSummaryLabel)};
			header.appendChild(summary);

			const count = document.createElement('div');
			count.className = 'tool-count';
			count.textContent = ${JSON.stringify(toolCountLabel)}.replace('{0}', String(messages.length));
			header.appendChild(count);
			container.appendChild(header);

			const labels = [];
			for (const message of messages) {
				const toolLabel = message.metadata && message.metadata.toolName ? (toolLabels[message.metadata.toolName] || message.metadata.toolName) : ${JSON.stringify(vscode.l10n.t('\u540e\u53f0\u5de5\u5177'))};
				if (!labels.includes(toolLabel)) {
					labels.push(toolLabel);
				}
			}

			const chips = document.createElement('div');
			chips.className = 'tool-chip-list';
			for (const label of labels) {
				const chip = document.createElement('div');
				chip.className = 'tool-chip';
				chip.textContent = label;
				chips.appendChild(chip);
			}
			container.appendChild(chips);

			const details = document.createElement('details');
			details.className = 'tool-details';
			const detailsSummary = document.createElement('summary');
			detailsSummary.textContent = ${JSON.stringify(toolDetailsLabel)};
			details.addEventListener('toggle', () => {
				detailsSummary.textContent = details.open ? ${JSON.stringify(toolCollapseLabel)} : ${JSON.stringify(toolDetailsLabel)};
			});
			details.appendChild(detailsSummary);

			for (const message of messages) {
				const toolLabel = message.metadata && message.metadata.toolName ? (toolLabels[message.metadata.toolName] || message.metadata.toolName) : ${JSON.stringify(vscode.l10n.t('\u540e\u53f0\u5de5\u5177'))};
				const item = document.createElement('div');
				item.className = 'tool-detail-item';

				const title = document.createElement('div');
				title.className = 'tool-detail-title';
				title.textContent = toolLabel;
				item.appendChild(title);

				const body = document.createElement('div');
				body.className = 'content';
				renderContent(body, message.content, false);
				item.appendChild(body);
				details.appendChild(item);
			}

			container.appendChild(details);
		}

		function render() {
			messagesEl.innerHTML = '';
			contextBadgesEl.innerHTML = '';
			for (const item of state.context.summary || []) {
				const badge = document.createElement('div');
				badge.className = 'badge';
				badge.textContent = item;
				contextBadgesEl.appendChild(badge);
			}

			attachmentListEl.innerHTML = '';
			if ((state.composer.attachments || []).length) {
				const activeAttachment = ensureActiveAttachment();
				attachmentsCardEl.className = 'card attachments-card';
				attachmentsEmptyEl.style.display = 'none';
				attachmentCountEl.textContent = ${JSON.stringify(attachedCountLabel)}.replace('{0}', String((state.composer.attachments || []).length));
				if (activeAttachment) {
					attachmentPeekEl.className = 'attachment-peek active';
					attachmentPeekBodyEl.textContent = [activeAttachment.detail, activeAttachment.preview].filter(Boolean).join('\\n\\n');
				} else {
					attachmentPeekEl.className = 'attachment-peek';
					attachmentPeekBodyEl.textContent = ${JSON.stringify(attachmentsPeekEmpty)};
				}
				for (const attachment of state.composer.attachments) {
					const item = document.createElement('div');
					item.className = attachment.id === activeAttachmentId ? 'attachment active' : 'attachment';
					item.addEventListener('click', () => {
						activeAttachmentId = attachment.id;
						render();
					});

					const kind = document.createElement('div');
					kind.className = 'attachment-kind';
					kind.textContent = attachmentKindLabels[attachment.kind] || attachment.kind;
					item.appendChild(kind);

					const main = document.createElement('div');
					main.className = 'attachment-main';

					const label = document.createElement('div');
					label.className = 'attachment-label';
					label.textContent = attachment.label;
					main.appendChild(label);

					const preview = document.createElement('div');
					preview.className = 'attachment-preview';
					preview.textContent = attachment.detail;
					preview.title = [attachment.detail, attachment.preview].filter(Boolean).join('\\n');
					main.appendChild(preview);
					item.appendChild(main);

					const remove = document.createElement('button');
					remove.className = 'attachment-remove';
					remove.textContent = '\u00d7';
					remove.addEventListener('click', event => {
						event.stopPropagation();
						vscode.postMessage({ type: 'removeAttachment', id: attachment.id });
					});
					item.appendChild(remove);

					attachmentListEl.appendChild(item);
				}
			} else {
				attachmentsCardEl.className = 'card attachments-card empty';
				attachmentsEmptyEl.style.display = 'block';
				attachmentsEmptyEl.textContent = ${JSON.stringify(attachmentsEmpty)};
				attachmentCountEl.textContent = '';
				attachmentPeekEl.className = 'attachment-peek';
				attachmentPeekBodyEl.textContent = ${JSON.stringify(attachmentsPeekEmpty)};
				activeAttachmentId = null;
			}

			if (state.proposal.active) {
				proposalEl.className = 'card proposal active';
				proposalModeEl.textContent = state.proposal.mode === 'replace' ? ${JSON.stringify(proposalReplaceModeLabel)} : ${JSON.stringify(proposalInsertModeLabel)};
				proposalBodyEl.textContent = state.proposal.targetLabel || '';
				reopenProposalEl.disabled = !state.proposal.reopenable;
			} else {
				proposalEl.className = 'card proposal';
				proposalModeEl.textContent = '';
				proposalBodyEl.textContent = '';
				reopenProposalEl.disabled = true;
			}

			if (!state.chat.messages.length) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = ${JSON.stringify(emptyState)};
				messagesEl.appendChild(empty);
			}

			const displayItems = createToolDisplayItems(state.chat.messages);
			if (state.chat.busy) {
				displayItems.push(createPendingToolDisplayItem());
			}

			for (const displayItem of displayItems) {
				if (displayItem.type === 'pending') {
					const pendingItem = document.createElement('div');
					pendingItem.className = 'message pending';

					const role = document.createElement('div');
					role.className = 'role';
					role.textContent = ${JSON.stringify(vscode.l10n.t('\u540e\u53f0'))};
					pendingItem.appendChild(role);

					const content = document.createElement('div');
					content.className = 'content';
					const paragraph = document.createElement('p');
					paragraph.textContent = displayItem.label;
					content.appendChild(paragraph);
					pendingItem.appendChild(content);

					messagesEl.appendChild(pendingItem);
					continue;
				}

				if (displayItem.type === 'toolGroup') {
					const toolItem = document.createElement('div');
					toolItem.className = 'message tool';

					const role = document.createElement('div');
					role.className = 'role';
					role.textContent = ${JSON.stringify(vscode.l10n.t('\u540e\u53f0'))};
					toolItem.appendChild(role);

					const content = document.createElement('div');
					content.className = 'content';
					renderToolGroup(content, displayItem.messages);
					toolItem.appendChild(content);

					messagesEl.appendChild(toolItem);
					continue;
				}

				const message = displayItem.message;
				const item = document.createElement('div');
				item.className = 'message ' + message.role;
				if (message.content.startsWith('\u9519\u8bef\uff1a')) {
					item.className += ' error';
				}

				const role = document.createElement('div');
				role.className = 'role';
				if (message.role === 'tool') {
					const toolLabel = message.metadata && message.metadata.toolName ? (toolLabels[message.metadata.toolName] || message.metadata.toolName) : '';
					role.textContent = ${JSON.stringify(vscode.l10n.t('\u540e\u53f0'))} + (toolLabel ? ' \u00b7 ' + toolLabel : '');
				} else if (message.role === 'assistant') {
					role.textContent = ${JSON.stringify(vscode.l10n.t('\u667a\u80fd\u4f53'))};
				} else if (message.role === 'user') {
					role.textContent = ${JSON.stringify(vscode.l10n.t('\u4f60'))};
				} else {
					role.textContent = message.role;
				}
				item.appendChild(role);

				const content = document.createElement('div');
				content.className = 'content';
				renderContent(content, message.content, true);
				item.appendChild(content);

				messagesEl.appendChild(item);
			}

			sendEl.disabled = state.chat.busy;
			instantSendEl.disabled = state.chat.busy || !(state.composer.attachments || []).length;
			sendEl.textContent = state.chat.busy ? ${JSON.stringify(thinking)} : ${JSON.stringify(send)};
			instantSendEl.textContent = state.chat.busy ? ${JSON.stringify(thinking)} : ${JSON.stringify(instantSendLabel)};
			statusEl.textContent = state.chat.busy ? ${JSON.stringify(composerBusyLabel)} : '';
			composerReadyEl.textContent = state.chat.busy ? ${JSON.stringify(composerBusyLabel)} : ((state.composer.attachments || []).length ? ${JSON.stringify(composerReadyLabel)} : '');
			messagesEl.scrollTop = messagesEl.scrollHeight;
			vscode.setState(state);
		}

		function send() {
			let prompt = promptEl.value.trim();
			if (!prompt && mode !== 'ask') {
				prompt = modeSeeds[mode] || '';
			}
			if (!prompt || state.chat.busy) {
				return;
			}
			vscode.postMessage({ type: 'send', prompt });
			promptEl.value = '';
			if (seededMode) {
				seededMode = null;
				setMode('ask');
			}
		}

		function setMode(nextMode) {
			mode = nextMode;
			for (const action of document.querySelectorAll('[data-mode]')) {
				action.className = action.getAttribute('data-mode') === mode ? 'mode-pill active' : 'mode-pill';
			}
			if (!promptEl.value.trim() && mode !== 'ask') {
				promptEl.value = modeSeeds[mode] || '';
				seededMode = mode;
				promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
			} else if (mode === 'ask') {
				seededMode = null;
			}
		}

		function instantSend() {
			if (state.chat.busy || !(state.composer.attachments || []).length) {
				return;
			}

			const seededPrompt = promptEl.value.trim() || modeSeeds[mode] || ${JSON.stringify(vscode.l10n.t('\u8bf7\u7ed3\u5408\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u7ee7\u7eed\u3002'))};
			vscode.postMessage({ type: 'send', prompt: seededPrompt });
			promptEl.value = '';
			if (seededMode) {
				seededMode = null;
				setMode('ask');
			}
		}

		sendEl.addEventListener('click', send);
		instantSendEl.addEventListener('click', instantSend);
		reopenProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'cursorAgent.reopenProposal' });
		});
		acceptProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'cursorAgent.acceptProposal' });
		});
		rejectProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'cursorAgent.rejectProposal' });
		});
		attachmentUseEl.addEventListener('click', () => {
			appendAttachmentToPrompt(ensureActiveAttachment(), false);
		});
		attachmentInsertSummaryEl.addEventListener('click', () => {
			appendAttachmentToPrompt(ensureActiveAttachment(), true);
		});
		clearAttachmentsEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'clearAttachments' });
		});
		for (const action of document.querySelectorAll('[data-command]')) {
			action.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: action.getAttribute('data-command') });
			});
		}
		for (const action of document.querySelectorAll('[data-seed]')) {
			action.addEventListener('click', () => {
				promptEl.value = action.getAttribute('data-seed') || '';
				seededMode = null;
				promptEl.focus();
				promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
			});
		}
		for (const action of document.querySelectorAll('[data-mode]')) {
			action.addEventListener('click', () => {
				setMode(action.getAttribute('data-mode') || 'ask');
				promptEl.focus();
			});
		}
		promptEl.addEventListener('keydown', event => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				send();
			}
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'state') {
				state = {
					chat: message.value.chat || { messages: [], busy: false },
					composer: message.value.composer || { attachments: [] },
					context: message.value.context || { summary: [] },
					proposal: message.value.proposal || { active: false }
				};
				render();
				return;
			}

			if (message.type === 'seedPrompt' && typeof message.value === 'string') {
				promptEl.value = message.value;
				mode = 'ask';
				seededMode = null;
				setMode('ask');
				promptEl.focus();
				promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
				return;
			}

			if (message.type === 'resetComposer') {
				promptEl.value = '';
				mode = 'ask';
				seededMode = null;
				activeAttachmentId = null;
				setMode('ask');
				render();
				return;
			}

			if (message.type === 'focusComposer') {
				promptEl.focus();
				promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
			}
		});

		const previous = vscode.getState();
		if (previous) {
			state = {
				chat: previous.chat || { messages: [], busy: false },
				composer: previous.composer || { attachments: [] },
				context: previous.context || { summary: [] },
				proposal: previous.proposal || { active: false }
			};
			render();
		}

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let i = 0; i < 32; i++) {
		value += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return value;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function joinContextBlocks(...parts: Array<string | undefined>): string | undefined {
	const normalized = parts
		.map(part => part?.trim())
		.filter((part): part is string => Boolean(part));
	return normalized.length ? normalized.join('\n\n') : undefined;
}
