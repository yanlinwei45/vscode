/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BeamService } from './beamService';
import { BeamComposerService, type IBeamComposerAttachmentState, type IBeamWebAttachmentInput } from './composerService';
import { BeamContextService } from './contextService';
import { BeamProposalService } from './proposalService';

export class BeamSidebarProvider extends vscode.Disposable implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;
	private pendingPrompt: string | undefined;
	private pendingStatusMessage: string | undefined;
	private shouldFocusComposer = false;
	private readonly localDisposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly service: BeamService,
		private readonly composerService: BeamComposerService,
		private readonly contextService: BeamContextService,
		private readonly proposalService: BeamProposalService
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
				const resolvedAttachments = this.composerService.resolveAttachments(message.prompt);
				const requestContext = joinContextBlocks(
					await this.contextService.buildPromptContext(),
					resolvedAttachments.context
				);
				await this.service.sendUserMessageWithAttachments(message.prompt, requestContext, resolvedAttachments);
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

			if (message.type === 'openAttachment' && typeof message.id === 'string') {
				const attachment = this.composerService.getState().attachments.find(item => item.id === message.id);
				if (attachment?.originalUri) {
					if (attachment.originalUri.startsWith('beam-upload:')) {
						void vscode.window.showInformationMessage(vscode.l10n.t('这是 Beam 会话内上传的附件，当前不会在编辑器中单独打开。'));
						return;
					}

					await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(attachment.originalUri), {
						preview: false
					});
				}
				return;
			}

			if (message.type === 'addWebAttachments' && Array.isArray(message.items)) {
				try {
					const attachments = this.composerService.addWebAttachments(message.items.filter(isWebAttachmentInput));
					for (const attachment of attachments) {
						this.showAttachmentAdded(attachment);
					}
				} catch (error) {
					const text = error instanceof Error ? error.message : vscode.l10n.t('附加文件失败。');
					if (this.view) {
						void this.view.webview.postMessage({ type: 'showComposerStatus', value: text });
					} else {
						this.pendingStatusMessage = text;
					}
					void vscode.window.showErrorMessage(text);
				}
				return;
			}

			if (message.type === 'toggleAttachment' && typeof message.id === 'string') {
				this.composerService.toggleAttachment(message.id);
				return;
			}

			if (message.type === 'clearAttachments') {
				this.composerService.clear();
				return;
			}

			if (message.type === 'resetComposer') {
				this.pendingPrompt = undefined;
				this.pendingStatusMessage = undefined;
				this.shouldFocusComposer = false;
				void this.view?.webview.postMessage({ type: 'resetComposer' });
				return;
			}

			if (message.type === 'ready') {
				this.postState();
				if (this.pendingPrompt !== undefined) {
					this.view?.show?.(true);
					void this.view?.webview.postMessage({ type: 'seedPrompt', value: this.pendingPrompt });
					this.pendingPrompt = undefined;
				}
				if (this.pendingStatusMessage !== undefined) {
					void this.view?.webview.postMessage({ type: 'showComposerStatus', value: this.pendingStatusMessage });
					this.pendingStatusMessage = undefined;
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

	showAttachmentAdded(_attachment: IBeamComposerAttachmentState): void {
		const message = vscode.l10n.t('已附加到对话，继续提问即可');
		if (this.view) {
			void this.view.webview.postMessage({ type: 'showComposerStatus', value: message });
			this.view.show?.(true);
			return;
		}

		this.pendingStatusMessage = message;
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
		const placeholder = vscode.l10n.t('\u8f93\u5165\u9700\u6c42\uff0c\u6bd4\u5982\uff1a\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\u3001\u4fee\u590d\u9519\u8bef\u3001\u91cd\u6784\u5f53\u524d\u6587\u4ef6...');
		const emptyState = vscode.l10n.t('\u4ece\u8fd9\u91cc\u76f4\u63a5\u5f00\u59cb\u4e00\u6bb5\u65b0\u5bf9\u8bdd\u3002');
		const send = vscode.l10n.t('\u53d1\u9001');
		const attachLabel = vscode.l10n.t('\u4e0a\u4f20');
		const thinking = vscode.l10n.t('\u601d\u8003\u4e2d...');
		const previewInsertLabel = vscode.l10n.t('\u9884\u89c8\u63d2\u5165');
		const previewReplaceLabel = vscode.l10n.t('\u9884\u89c8\u66ff\u6362');
		const proposalTitle = vscode.l10n.t('\u7f16\u8f91\u63d0\u6848');
		const proposalFilesLabel = vscode.l10n.t('\u5f85\u786e\u8ba4\u6587\u4ef6');
		const acceptLabel = vscode.l10n.t('\u63a5\u53d7');
		const rejectLabel = vscode.l10n.t('\u62d2\u7edd');
		const reopenProposalLabel = vscode.l10n.t('\u6253\u5f00\u5bf9\u6bd4');
		const focusProposalLabel = vscode.l10n.t('\u5b9a\u4f4d\u5230\u7f16\u8f91\u5668');
		const nextProposalLabel = vscode.l10n.t('\u4e0b\u4e00\u4e2a\u6587\u4ef6');
		const previousProposalLabel = vscode.l10n.t('\u4e0a\u4e00\u4e2a\u6587\u4ef6');
		const toolSummaryLabel = vscode.l10n.t('\u540e\u53f0\u6267\u884c');
		const toolDetailsLabel = vscode.l10n.t('\u5c55\u5f00\u8be6\u60c5');
		const toolCollapseLabel = vscode.l10n.t('\u6536\u8d77\u8be6\u60c5');
		const toolCountLabel = vscode.l10n.t('\u5171 {0} \u6b65');
		const runningToolLabel = vscode.l10n.t('\u6b63\u5728\u5904\u7406\uff1a{0}');
		const proposalInsertModeLabel = vscode.l10n.t('\u63d2\u5165');
		const proposalReplaceModeLabel = vscode.l10n.t('\u66ff\u6362');
		const proposalFileModeLabel = vscode.l10n.t('\u6587\u4ef6');
		const fallbackPrompt = vscode.l10n.t('\u8bf7\u7ed3\u5408\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u7ee7\u7eed\u3002');
		const assistantLabel = vscode.l10n.t('\u667a\u80fd\u4f53');
		const userLabel = vscode.l10n.t('\u4f60');
		const backgroundLabel = vscode.l10n.t('\u540e\u53f0');
		const preparingLabel = vscode.l10n.t('\u51c6\u5907\u4e2d');
		const toolLabelFallback = vscode.l10n.t('\u540e\u53f0\u5de5\u5177');
		const titleText = vscode.l10n.t('Beam');
		const historyLabel = vscode.l10n.t('\u5386\u53f2\u8bb0\u5f55');
		const newChatLabel = vscode.l10n.t('\u65b0\u5efa\u5bf9\u8bdd');
		const currentChatLabel = vscode.l10n.t('\u5f53\u524d\u5bf9\u8bdd');
		const historyEmptyLabel = vscode.l10n.t('\u6682\u65e0\u5386\u53f2\u5bf9\u8bdd');
		const composerHint = vscode.l10n.t('\u56de\u8f66\u53d1\u9001\uff0cShift+Enter \u6362\u884c');
		const dropHint = vscode.l10n.t('\u62d6\u62fd\u6587\u4ef6/\u56fe\u7247\u5230\u8fd9\u91cc\uff0c\u6216\u76f4\u63a5\u7c98\u8d34\u622a\u56fe');
		const attachmentsAddedLabel = vscode.l10n.t('已附加 {0} 个附件');
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(titleText)}</title>
	<style nonce="${nonce}">
		:root {
			color-scheme: light dark;
		}
		body {
			margin: 0;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			background: var(--vscode-sideBar-background);
			color: var(--vscode-sideBar-foreground);
		}
		.shell {
			display: grid;
			grid-template-rows: auto minmax(0, 1fr) auto;
			height: 100vh;
			background:
				radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-button-background) 16%, transparent), transparent 28%),
				var(--vscode-sideBar-background);
		}
		.topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			padding: 8px 10px;
			border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 76%, transparent);
			background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
			backdrop-filter: blur(10px);
		}
		.topbar-left {
			display: flex;
			align-items: center;
			gap: 8px;
			min-width: 0;
		}
		.chat-title {
			font-size: 12px;
			font-weight: 700;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			max-width: 180px;
		}
		.topbar-button {
			padding: 6px 10px;
			font-size: 11px;
			font-weight: 600;
		}
		.history {
			display: none;
			padding: 8px 10px 0;
		}
		.history.active {
			display: block;
		}
		.history-list {
			display: grid;
			gap: 6px;
		}
		.history-item {
			display: grid;
			gap: 3px;
			padding: 8px 10px;
			border-radius: 12px;
			border: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
			cursor: pointer;
			text-align: left;
		}
		.history-item.active {
			border-color: color-mix(in srgb, var(--vscode-button-background) 36%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
		}
		.history-item-title {
			font-size: 12px;
			font-weight: 700;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.history-item-preview {
			font-size: 11px;
			opacity: 0.72;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.history-empty {
			padding: 10px 11px;
			border-radius: 12px;
			border: 1px dashed var(--vscode-panel-border);
			font-size: 11px;
			opacity: 0.72;
		}
		.messages {
			overflow: auto;
			padding: 10px 10px 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.empty {
			padding: 12px 13px;
			border-radius: 14px;
			border: 1px dashed var(--vscode-panel-border);
			line-height: 1.6;
			opacity: 0.72;
			background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
		}
		.message {
			padding: 10px 11px;
			border-radius: 14px;
			border: 1px solid var(--vscode-panel-border);
			line-height: 1.55;
			font-size: 14px;
			background: color-mix(in srgb, var(--vscode-editor-background) 78%, var(--vscode-sideBar-background));
			box-shadow: 0 6px 14px rgba(0, 0, 0, 0.05);
			max-width: calc(100% - 12px);
		}
		.message.user {
			background: color-mix(in srgb, var(--vscode-button-background) 15%, transparent);
			margin-left: 18px;
			border-color: color-mix(in srgb, var(--vscode-button-background) 22%, var(--vscode-panel-border));
		}
		.message.tool {
			background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent);
			box-shadow: none;
			position: relative;
			padding-left: 14px;
			margin-right: 10px;
		}
		.message.tool::before {
			content: '';
			position: absolute;
			inset: 0 auto 0 0;
			width: 3px;
			border-radius: 16px 0 0 16px;
			background: color-mix(in srgb, var(--vscode-textLink-foreground) 72%, transparent);
		}
		.message.pending {
			border-style: dashed;
			box-shadow: none;
			opacity: 0.9;
		}
		.message.error {
			border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, var(--vscode-panel-border));
		}
		.role {
			font-size: 11px;
			opacity: 0.58;
			margin-bottom: 6px;
		}
		.content {
			display: grid;
			gap: 10px;
		}
		.content p {
			margin: 0;
			white-space: pre-wrap;
			word-break: break-word;
		}
		.content pre {
			margin: 0;
			padding: 11px 12px;
			border-radius: 12px;
			overflow: auto;
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, black 12%);
			border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
		}
		.content code {
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
			font-size: 13px;
		}
		.code-actions {
			display: flex;
			justify-content: flex-end;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 8px;
		}
		.tool-line {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
		.tool-summary {
			font-size: 12px;
			font-weight: 700;
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
			margin-top: 8px;
		}
		.tool-details summary {
			cursor: pointer;
			font-size: 11px;
			opacity: 0.72;
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
		.composer {
			border-top: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent);
			padding: 8px 10px 10px;
			display: grid;
			gap: 8px;
		}
		.proposal {
			display: none;
			gap: 10px;
			padding: 12px;
			border-radius: 16px;
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 26%, var(--vscode-panel-border));
			background:
				linear-gradient(135deg, color-mix(in srgb, var(--vscode-button-background) 12%, transparent), transparent 72%),
				color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
		}
		.proposal.active {
			display: grid;
		}
		.proposal-top {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			flex-wrap: wrap;
		}
		.proposal-title {
			font-size: 12px;
			font-weight: 700;
		}
		.proposal-mode {
			border-radius: 999px;
			padding: 4px 8px;
			font-size: 11px;
			font-weight: 700;
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 35%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-button-background) 16%, transparent);
		}
		.proposal-body {
			font-size: 12px;
			line-height: 1.5;
			opacity: 0.86;
			word-break: break-word;
		}
		.proposal-files {
			display: none;
			gap: 6px;
			flex-wrap: wrap;
		}
		.proposal-files.active {
			display: flex;
		}
		.proposal-file-chip {
			border-radius: 999px;
			padding: 5px 9px;
			font-size: 11px;
			border: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
			cursor: pointer;
		}
		.proposal-file-chip.active {
			border-color: color-mix(in srgb, var(--vscode-button-background) 36%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-button-background) 16%, transparent);
			font-weight: 700;
		}
		.proposal-actions {
			display: flex;
			justify-content: flex-end;
			flex-wrap: wrap;
			gap: 8px;
		}
		.composer-shell {
			display: grid;
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			border-radius: 18px;
			background: var(--vscode-input-background);
			overflow: hidden;
			box-shadow: inset 0 1px 0 color-mix(in srgb, white 6%, transparent);
			transition: border-color 120ms ease, box-shadow 120ms ease;
			position: relative;
		}
		.composer-shell:focus-within {
			border-color: color-mix(in srgb, var(--vscode-focusBorder) 78%, var(--vscode-input-border, var(--vscode-panel-border)));
			box-shadow:
				0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 34%, transparent),
				0 10px 22px rgba(0, 0, 0, 0.08);
		}
		.composer-shell.dragover {
			border-color: color-mix(in srgb, var(--vscode-button-background) 78%, var(--vscode-focusBorder));
			box-shadow:
				0 0 0 1px color-mix(in srgb, var(--vscode-button-background) 28%, transparent),
				0 14px 30px rgba(0, 0, 0, 0.12);
		}
		.composer-drop-overlay {
			position: absolute;
			inset: 0;
			display: none;
			align-items: center;
			justify-content: center;
			padding: 18px;
			text-align: center;
			font-size: 14px;
			font-weight: 700;
			line-height: 1.5;
			color: var(--vscode-button-foreground);
			background: color-mix(in srgb, var(--vscode-button-background) 82%, transparent);
			backdrop-filter: blur(6px);
			z-index: 2;
		}
		.composer-drop-overlay.active {
			display: flex;
		}
		.composer-attachments {
			display: none;
			flex-wrap: nowrap;
			gap: 6px;
			padding: 8px 10px 0;
			overflow-x: auto;
			scrollbar-width: thin;
		}
		.composer-attachments.active {
			display: flex;
		}
		.composer-attachment {
			display: flex;
			align-items: center;
			gap: 6px;
			max-width: 260px;
			padding: 5px 8px;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 22%, var(--vscode-panel-border));
			background: color-mix(in srgb, var(--vscode-button-background) 10%, transparent);
			flex: 0 0 auto;
			cursor: pointer;
			transition: opacity 120ms ease, transform 120ms ease, border-color 120ms ease, background 120ms ease;
		}
		.composer-attachment:hover {
			transform: translateY(-1px);
		}
		.composer-attachment.off {
			opacity: 0.58;
			border-style: dashed;
			background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
		}
		.attachment-kind {
			border-radius: 999px;
			padding: 2px 7px;
			font-size: 10px;
			background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
			border: 1px solid color-mix(in srgb, var(--vscode-button-background) 26%, var(--vscode-panel-border));
			opacity: 0.92;
			flex: 0 0 auto;
		}
		.composer-attachment-label {
			font-size: 11px;
			font-weight: 700;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.attachment-thumb {
			width: 26px;
			height: 26px;
			border-radius: 8px;
			object-fit: cover;
			flex: 0 0 auto;
			border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
			background: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
		}
		.attachment-meta {
			font-size: 10px;
			opacity: 0.68;
			flex: 0 0 auto;
			max-width: 96px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.attachment-open {
			border: 0;
			background: transparent;
			color: inherit;
			width: 18px;
			height: 18px;
			padding: 0;
			border-radius: 999px;
			font-size: 12px;
			cursor: pointer;
			flex: 0 0 auto;
			opacity: 0.78;
		}
		.attachment-open:hover {
			background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
		}
		.attachment-remove {
			border: 0;
			background: transparent;
			color: inherit;
			width: 18px;
			height: 18px;
			padding: 0;
			border-radius: 999px;
			font-size: 13px;
			line-height: 18px;
			cursor: pointer;
			flex: 0 0 auto;
		}
		textarea {
			width: 100%;
			min-height: 72px;
			max-height: 188px;
			resize: none;
			box-sizing: border-box;
			border: 0;
			background: transparent;
			color: var(--vscode-input-foreground);
			padding: 12px 13px 10px;
			font: inherit;
			font-size: 15px;
			line-height: 1.55;
			outline: none;
			overflow-y: hidden;
		}
		textarea.prompt-scroll {
			overflow-y: auto;
		}
		.composer-footer {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			padding: 0 10px 10px;
		}
		.composer-meta {
			display: grid;
			gap: 4px;
			min-width: 0;
		}
		.composer-status {
			font-size: 11px;
			opacity: 0;
			transform: translateY(4px);
			transition: opacity 120ms ease, transform 120ms ease;
			pointer-events: none;
		}
		.composer-status.active {
			opacity: 0.7;
			transform: translateY(0);
		}
		.composer-hint {
			font-size: 12px;
			opacity: 0.6;
			white-space: nowrap;
		}
		.composer-shell.flash {
			border-color: color-mix(in srgb, var(--vscode-button-background) 72%, var(--vscode-input-border, var(--vscode-panel-border)));
			box-shadow:
				0 0 0 1px color-mix(in srgb, var(--vscode-button-background) 24%, transparent),
				0 12px 26px rgba(0, 0, 0, 0.08);
		}
		.composer-actions {
			display: flex;
			justify-content: flex-end;
			flex: 0 0 auto;
		}
		button {
			border: 0;
			border-radius: 999px;
			padding: 8px 14px;
			font: inherit;
			font-weight: 600;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
		}
		button.secondary {
			border: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
			color: inherit;
		}
		button[disabled] {
			opacity: 0.5;
			cursor: default;
		}
		.send-button {
			min-width: 76px;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="topbar">
			<div class="topbar-left">
				<button id="toggleHistory" class="secondary topbar-button">${escapeHtml(historyLabel)}</button>
				<div id="activeChatTitle" class="chat-title">${escapeHtml(currentChatLabel)}</div>
			</div>
			<button id="newChat" class="secondary topbar-button">${escapeHtml(newChatLabel)}</button>
		</div>
		<div id="historyPanel" class="history">
			<div id="historyList" class="history-list"></div>
		</div>
		<div id="messages" class="messages"></div>
		<div class="composer">
			<div id="proposal" class="proposal">
				<div class="proposal-top">
					<div class="proposal-title">${escapeHtml(proposalTitle)}</div>
					<div id="proposalMode" class="proposal-mode"></div>
				</div>
				<div id="proposalBody" class="proposal-body"></div>
				<div id="proposalFiles" class="proposal-files"></div>
				<div class="proposal-actions">
					<button id="previousProposal" class="secondary">${escapeHtml(previousProposalLabel)}</button>
					<button id="nextProposal" class="secondary">${escapeHtml(nextProposalLabel)}</button>
					<button id="reopenProposal" class="secondary">${escapeHtml(reopenProposalLabel)}</button>
					<button id="focusProposal" class="secondary">${escapeHtml(focusProposalLabel)}</button>
					<button id="rejectProposal" class="secondary">${escapeHtml(rejectLabel)}</button>
					<button id="acceptProposal">${escapeHtml(acceptLabel)}</button>
				</div>
			</div>
				<div class="composer-shell">
					<div id="composerDropOverlay" class="composer-drop-overlay">${escapeHtml(dropHint)}</div>
					<div id="composerAttachments" class="composer-attachments"></div>
					<textarea id="prompt" placeholder="${escapeHtml(placeholder)}"></textarea>
					<div class="composer-footer">
						<div class="composer-meta">
							<div id="composerStatus" class="composer-status"></div>
							<div class="composer-hint">${escapeHtml(composerHint)}</div>
						</div>
						<div class="composer-actions">
							<button id="attach" class="secondary">${escapeHtml(attachLabel)}</button>
							<button id="send" class="send-button">${escapeHtml(send)}</button>
						</div>
					</div>
				</div>
			</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const toggleHistoryEl = document.getElementById('toggleHistory');
		const newChatEl = document.getElementById('newChat');
		const historyPanelEl = document.getElementById('historyPanel');
		const historyListEl = document.getElementById('historyList');
		const activeChatTitleEl = document.getElementById('activeChatTitle');
		const promptEl = document.getElementById('prompt');
		const composerShellEl = document.querySelector('.composer-shell');
		const composerDropOverlayEl = document.getElementById('composerDropOverlay');
		const composerStatusEl = document.getElementById('composerStatus');
		const attachEl = document.getElementById('attach');
		const sendEl = document.getElementById('send');
		const composerAttachmentsEl = document.getElementById('composerAttachments');
		const proposalEl = document.getElementById('proposal');
		const proposalBodyEl = document.getElementById('proposalBody');
		const proposalModeEl = document.getElementById('proposalMode');
		const proposalFilesEl = document.getElementById('proposalFiles');
		const previousProposalEl = document.getElementById('previousProposal');
		const nextProposalEl = document.getElementById('nextProposal');
		const reopenProposalEl = document.getElementById('reopenProposal');
		const focusProposalEl = document.getElementById('focusProposal');
		const acceptProposalEl = document.getElementById('acceptProposal');
		const rejectProposalEl = document.getElementById('rejectProposal');
		const previewInsertCommand = 'beam.previewInsertCodeBlock';
		const previewReplaceCommand = 'beam.previewReplaceSelectionWithCodeBlock';
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
			create_edit_proposal: ${JSON.stringify(vscode.l10n.t('\u521b\u5efa\u7f16\u8f91\u63d0\u6848'))},
			write_file: ${JSON.stringify(vscode.l10n.t('\u5199\u5165\u6587\u4ef6'))},
			create_file: ${JSON.stringify(vscode.l10n.t('\u521b\u5efa\u6587\u4ef6'))},
			replace_in_file: ${JSON.stringify(vscode.l10n.t('\u66ff\u6362\u6587\u4ef6\u5185\u5bb9'))},
			run_command: ${JSON.stringify(vscode.l10n.t('\u6267\u884c\u547d\u4ee4'))}
		};
		const attachmentKindLabels = {
			selection: ${JSON.stringify(vscode.l10n.t('\u9009\u533a'))},
			file: ${JSON.stringify(vscode.l10n.t('\u6587\u4ef6'))},
			problems: ${JSON.stringify(vscode.l10n.t('\u95ee\u9898'))},
			upload: ${JSON.stringify(vscode.l10n.t('\u9644\u4ef6'))},
			image: ${JSON.stringify(vscode.l10n.t('\u56fe\u7247'))},
			pdf: ${JSON.stringify(vscode.l10n.t('PDF'))}
		};
		let state = { chat: { messages: [], busy: false, sessions: [] }, composer: { attachments: [] }, context: { summary: [] }, proposal: { active: false } };
		let historyVisible = false;
		let composerStatusTimer = undefined;
		let dragDepth = 0;

		function showComposerStatus(text) {
			if (!composerShellEl || !composerStatusEl) {
				return;
			}

			composerShellEl.classList.add('flash');
			composerStatusEl.textContent = text || '';
			composerStatusEl.className = text ? 'composer-status active' : 'composer-status';
			clearTimeout(composerStatusTimer);
			composerStatusTimer = setTimeout(() => {
				composerShellEl.classList.remove('flash');
				composerStatusEl.className = 'composer-status';
			}, 1400);
		}

		function focusComposer() {
			syncPromptHeight();
			promptEl.focus();
			promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
		}

		function syncPromptHeight() {
			const computed = window.getComputedStyle(promptEl);
			const lineHeight = Math.max(1, Number.parseFloat(computed.lineHeight) || 20);
			const padding = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
			const minRows = 3;
			const maxRows = 8;
			promptEl.rows = minRows;
			const contentHeight = Math.max(0, promptEl.scrollHeight - padding);
			const nextRows = Math.max(minRows, Math.min(maxRows, Math.ceil(contentHeight / lineHeight)));
			promptEl.rows = nextRows;
			promptEl.classList.toggle('prompt-scroll', nextRows >= maxRows);
		}

		function appendPromptValue(value) {
			if (!value) {
				return;
			}

			const normalized = promptEl.value.trimEnd();
			promptEl.value = normalized ? normalized + '\\n' + value : value;
			focusComposer();
			showComposerStatus(${JSON.stringify(vscode.l10n.t('\u5df2\u52a0\u5165\u8f93\u5165\u6846'))});
		}

		function setDragActive(active) {
			if (!composerShellEl || !composerDropOverlayEl) {
				return;
			}

			composerShellEl.classList.toggle('dragover', active);
			composerDropOverlayEl.classList.toggle('active', active);
		}

		function hasFileTransfer(event) {
			const types = Array.from(event.dataTransfer?.types || []);
			return types.includes('Files');
		}

		async function readFileAsBase64(file) {
			const buffer = await file.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			let binary = '';
			const chunkSize = 0x8000;
			for (let i = 0; i < bytes.length; i += chunkSize) {
				binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
			}

			return btoa(binary);
		}

		async function postWebAttachments(fileList) {
			if (!fileList || !fileList.length) {
				return;
			}

			const items = [];
			for (const file of Array.from(fileList)) {
				items.push({
					name: file.name,
					mediaType: file.type || undefined,
					data: await readFileAsBase64(file)
				});
			}

			if (items.length) {
				vscode.postMessage({ type: 'addWebAttachments', items });
				showComposerStatus(${JSON.stringify(attachmentsAddedLabel)}.replace('{0}', String(items.length)));
			}
		}

		function seedPromptValue(value) {
			if (!value) {
				promptEl.value = '';
				focusComposer();
				return;
			}

			const existing = promptEl.value.trim();
			promptEl.value = existing ? existing + '\\n\\n' + value : value;
			focusComposer();
		}

		function createCodeActions(code) {
			const actions = document.createElement('div');
			actions.className = 'code-actions';

			const previewInsert = document.createElement('button');
			previewInsert.className = 'secondary';
			previewInsert.textContent = ${JSON.stringify(previewInsertLabel)};
			previewInsert.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: previewInsertCommand, args: [code] });
			});
			actions.appendChild(previewInsert);

			const previewReplace = document.createElement('button');
			previewReplace.className = 'secondary';
			previewReplace.textContent = ${JSON.stringify(previewReplaceLabel)};
			previewReplace.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: previewReplaceCommand, args: [code] });
			});
			actions.appendChild(previewReplace);

			return actions;
		}

		function renderContent(container, text, includeCodeActions) {
			const fence = String.fromCharCode(96, 96, 96);
			const parts = String(text || '').split(fence);
			for (let index = 0; index < parts.length; index++) {
				if (!parts[index]) {
					continue;
				}

				if (index % 2 === 1) {
					const pre = document.createElement('pre');
					const code = document.createElement('code');
					const normalized = parts[index].replace(/^\\n+|\\n+$/g, '');
					const lines = normalized.split('\\n');
					const firstLine = lines[0] ?? '';
					const body = /^[a-z0-9_+#.-]+$/i.test(firstLine) ? lines.slice(1).join('\\n') : normalized;
					code.textContent = body;
					pre.appendChild(code);
					container.appendChild(pre);
					if (includeCodeActions && body) {
						container.appendChild(createCodeActions(body));
					}
					continue;
				}

				const paragraphs = parts[index].split(/\\n{2,}/g).filter(Boolean);
				for (const paragraph of paragraphs) {
					const p = document.createElement('p');
					p.textContent = paragraph;
					container.appendChild(p);
				}
			}
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
				label: ${JSON.stringify(runningToolLabel)}.replace('{0}', labels.length ? labels.join('\u3001') : ${JSON.stringify(preparingLabel)})
			};
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
				const label = message.metadata && message.metadata.toolName ? (toolLabels[message.metadata.toolName] || message.metadata.toolName) : ${JSON.stringify(toolLabelFallback)};
				if (!labels.includes(label)) {
					labels.push(label);
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
			const summaryEl = document.createElement('summary');
			summaryEl.textContent = ${JSON.stringify(toolDetailsLabel)};
			details.addEventListener('toggle', () => {
				summaryEl.textContent = details.open ? ${JSON.stringify(toolCollapseLabel)} : ${JSON.stringify(toolDetailsLabel)};
			});
			details.appendChild(summaryEl);

			for (const message of messages) {
				const item = document.createElement('div');
				item.className = 'tool-detail-item';

				const title = document.createElement('div');
				title.className = 'tool-detail-title';
				title.textContent = message.metadata && message.metadata.toolName ? (toolLabels[message.metadata.toolName] || message.metadata.toolName) : ${JSON.stringify(toolLabelFallback)};
				item.appendChild(title);

				const body = document.createElement('div');
				body.className = 'content';
				renderContent(body, message.content, false);
				item.appendChild(body);
				details.appendChild(item);
			}

			container.appendChild(details);
		}

		function renderSessions() {
			historyListEl.innerHTML = '';
			const sessions = state.chat.sessions || [];
			activeChatTitleEl.textContent = state.chat.activeSessionTitle || ${JSON.stringify(currentChatLabel)};
			historyPanelEl.className = historyVisible ? 'history active' : 'history';

			if (!historyVisible) {
				return;
			}

			if (!sessions.length) {
				const empty = document.createElement('div');
				empty.className = 'history-empty';
				empty.textContent = ${JSON.stringify(historyEmptyLabel)};
				historyListEl.appendChild(empty);
				return;
			}

			for (const session of sessions) {
				const item = document.createElement('button');
				item.className = session.id === state.chat.activeSessionId ? 'history-item active' : 'history-item';
				item.addEventListener('click', () => {
					historyVisible = false;
					vscode.postMessage({ type: 'command', command: 'beam.openSession', args: [session.id] });
				});

				const title = document.createElement('div');
				title.className = 'history-item-title';
				title.textContent = session.title;
				item.appendChild(title);

				const preview = document.createElement('div');
				preview.className = 'history-item-preview';
				preview.textContent = session.preview || '';
				item.appendChild(preview);

				historyListEl.appendChild(item);
			}
		}

		function renderAttachments() {
			composerAttachmentsEl.innerHTML = '';
			const attachments = state.composer.attachments || [];
			if (!attachments.length) {
				composerAttachmentsEl.className = 'composer-attachments';
				return;
			}

			composerAttachmentsEl.className = 'composer-attachments active';
			for (const attachment of attachments) {
				const item = document.createElement('div');
				item.className = attachment.included ? 'composer-attachment' : 'composer-attachment off';
				item.title = [attachment.label, attachment.detail, attachment.preview].filter(Boolean).join('\\n');
				item.addEventListener('click', () => {
					vscode.postMessage({ type: 'toggleAttachment', id: attachment.id });
				});

				const kind = document.createElement('div');
				kind.className = 'attachment-kind';
				kind.textContent = attachmentKindLabels[attachment.kind] || attachment.kind;
				item.appendChild(kind);

				if (attachment.kind === 'image' && attachment.previewUrl) {
					const thumb = document.createElement('img');
					thumb.className = 'attachment-thumb';
					thumb.src = attachment.previewUrl;
					thumb.alt = attachment.label;
					item.appendChild(thumb);
				}

				const label = document.createElement('div');
				label.className = 'composer-attachment-label';
				label.textContent = attachment.label;
				item.appendChild(label);

				const meta = document.createElement('div');
				meta.className = 'attachment-meta';
				meta.textContent = attachment.detail || (Math.max(1, Math.ceil((attachment.contentLength || 0) / 1000)) + 'k');
				item.appendChild(meta);

				if (attachment.originalUri) {
					const open = document.createElement('button');
					open.className = 'attachment-open';
					open.textContent = '↗';
					open.title = ${JSON.stringify(vscode.l10n.t('打开附件'))};
					open.addEventListener('click', event => {
						event.stopPropagation();
						vscode.postMessage({ type: 'openAttachment', id: attachment.id });
					});
					item.appendChild(open);
				}

				const remove = document.createElement('button');
				remove.className = 'attachment-remove';
				remove.textContent = '\u00d7';
				remove.addEventListener('click', event => {
					event.stopPropagation();
					vscode.postMessage({ type: 'removeAttachment', id: attachment.id });
				});
				item.appendChild(remove);

				composerAttachmentsEl.appendChild(item);
			}
		}

		function renderProposal() {
			if (!state.proposal.active) {
				proposalEl.className = 'proposal';
				proposalModeEl.textContent = '';
				proposalBodyEl.textContent = '';
				proposalFilesEl.innerHTML = '';
				proposalFilesEl.className = 'proposal-files';
				previousProposalEl.disabled = true;
				nextProposalEl.disabled = true;
				reopenProposalEl.disabled = true;
				focusProposalEl.disabled = true;
				return;
			}

			proposalEl.className = 'proposal active';
			proposalModeEl.textContent = state.proposal.mode === 'replace'
				? ${JSON.stringify(proposalReplaceModeLabel)}
				: state.proposal.mode === 'file'
					? ${JSON.stringify(proposalFileModeLabel)}
					: ${JSON.stringify(proposalInsertModeLabel)};
			const progress = state.proposal.total ? ' (' + (state.proposal.currentIndex || 1) + '/' + state.proposal.total + ')' : '';
			proposalBodyEl.textContent = (state.proposal.targetLabel || '') + progress;
			proposalFilesEl.innerHTML = '';
			const files = state.proposal.files || [];
			if (files.length > 1) {
				proposalFilesEl.className = 'proposal-files active';
				const label = document.createElement('div');
				label.className = 'tool-count';
				label.textContent = ${JSON.stringify(proposalFilesLabel)};
				proposalFilesEl.appendChild(label);
				for (const file of files) {
					const chip = document.createElement('button');
					chip.className = file.isActive ? 'proposal-file-chip active' : 'proposal-file-chip';
					chip.textContent = file.label;
					chip.addEventListener('click', () => {
						vscode.postMessage({ type: 'command', command: 'beam.openPendingChange', args: [file.id] });
					});
					proposalFilesEl.appendChild(chip);
				}
			} else {
				proposalFilesEl.className = 'proposal-files';
			}
			previousProposalEl.disabled = !state.proposal.hasMultipleFiles;
			nextProposalEl.disabled = !state.proposal.hasMultipleFiles;
			reopenProposalEl.disabled = !state.proposal.reopenable;
			focusProposalEl.disabled = !state.proposal.active;
		}

		function renderMessages() {
			messagesEl.innerHTML = '';
			const messages = state.chat.messages || [];
			if (!messages.length) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = ${JSON.stringify(emptyState)};
				messagesEl.appendChild(empty);
			}

			const displayItems = createToolDisplayItems(messages);
			if (state.chat.busy) {
				displayItems.push(createPendingToolDisplayItem());
			}

			for (const displayItem of displayItems) {
				if (displayItem.type === 'pending') {
					const pendingItem = document.createElement('div');
					pendingItem.className = 'message pending';

					const role = document.createElement('div');
					role.className = 'role';
					role.textContent = ${JSON.stringify(backgroundLabel)};
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
					role.textContent = ${JSON.stringify(backgroundLabel)};
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
				if (String(message.content || '').startsWith('\u9519\u8bef\uff1a')) {
					item.className += ' error';
				}

				const role = document.createElement('div');
				role.className = 'role';
				if (message.role === 'assistant') {
					role.textContent = ${JSON.stringify(assistantLabel)};
				} else if (message.role === 'user') {
					role.textContent = ${JSON.stringify(userLabel)};
				} else {
					role.textContent = message.role;
				}
				item.appendChild(role);

				const content = document.createElement('div');
				content.className = 'content';
				renderContent(content, message.content, message.role === 'assistant');
				item.appendChild(content);

				messagesEl.appendChild(item);
			}

			messagesEl.scrollTop = messagesEl.scrollHeight;
		}

		function render() {
			renderSessions();
			renderAttachments();
			renderProposal();
			renderMessages();
			sendEl.disabled = state.chat.busy;
			attachEl.disabled = state.chat.busy;
			sendEl.textContent = state.chat.busy ? ${JSON.stringify(thinking)} : ${JSON.stringify(send)};
			vscode.setState(state);
		}

		function send() {
			let prompt = promptEl.value.trim();
			if (!prompt && (state.composer.attachments || []).some(attachment => attachment.included)) {
				prompt = ${JSON.stringify(fallbackPrompt)};
			}
			if (!prompt || state.chat.busy) {
				return;
			}

			vscode.postMessage({ type: 'send', prompt });
			promptEl.value = '';
			syncPromptHeight();
		}

		sendEl.addEventListener('click', send);
		attachEl.addEventListener('click', () => {
			if (state.chat.busy) {
				return;
			}

			vscode.postMessage({ type: 'command', command: 'beam.addAttachment' });
		});
		toggleHistoryEl.addEventListener('click', () => {
			historyVisible = !historyVisible;
			render();
		});
		newChatEl.addEventListener('click', () => {
			historyVisible = false;
			vscode.postMessage({ type: 'command', command: 'beam.newChat' });
		});
		reopenProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.reopenProposal' });
		});
		focusProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.focusActiveProposal' });
		});
		previousProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.previousProposal' });
		});
		nextProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.nextProposal' });
		});
		acceptProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.acceptProposal' });
		});
		rejectProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'beam.rejectProposal' });
		});
		promptEl.addEventListener('keydown', event => {
			const isPlainEnter = event.key === 'Enter'
				&& !event.shiftKey
				&& !event.altKey
				&& !event.ctrlKey
				&& !event.metaKey
				&& !event.isComposing
				&& !event.repeat;
			if (!isPlainEnter) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			send();
		});
		promptEl.addEventListener('input', () => {
			syncPromptHeight();
		});
		composerShellEl.addEventListener('dragenter', event => {
			if (state.chat.busy || !hasFileTransfer(event)) {
				return;
			}

			event.preventDefault();
			dragDepth += 1;
			setDragActive(true);
		});
		composerShellEl.addEventListener('dragover', event => {
			if (state.chat.busy || !hasFileTransfer(event)) {
				return;
			}

			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
			setDragActive(true);
		});
		composerShellEl.addEventListener('dragleave', event => {
			if (state.chat.busy || !hasFileTransfer(event)) {
				return;
			}

			event.preventDefault();
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) {
				setDragActive(false);
			}
		});
		composerShellEl.addEventListener('drop', async event => {
			if (state.chat.busy || !hasFileTransfer(event)) {
				return;
			}

			event.preventDefault();
			dragDepth = 0;
			setDragActive(false);
			await postWebAttachments(event.dataTransfer.files);
		});
		promptEl.addEventListener('paste', async event => {
			const files = Array.from(event.clipboardData?.files || []);
			if (!files.length || state.chat.busy) {
				return;
			}

			event.preventDefault();
			await postWebAttachments(files);
			showComposerStatus(${JSON.stringify(vscode.l10n.t('\u5df2\u7c98\u8d34\u4e3a Beam \u9644\u4ef6'))});
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'state') {
				state = {
					chat: message.value.chat || { messages: [], busy: false, sessions: [] },
					composer: message.value.composer || { attachments: [] },
					context: message.value.context || { summary: [] },
					proposal: message.value.proposal || { active: false }
				};
				render();
				return;
			}

			if (message.type === 'seedPrompt' && typeof message.value === 'string') {
				seedPromptValue(message.value);
				return;
			}

			if (message.type === 'appendPrompt' && typeof message.value === 'string') {
				appendPromptValue(message.value);
				return;
			}

			if (message.type === 'showComposerStatus' && typeof message.value === 'string') {
				showComposerStatus(message.value);
				return;
			}

			if (message.type === 'resetComposer') {
				promptEl.value = '';
				syncPromptHeight();
				render();
				return;
			}

			if (message.type === 'focusComposer') {
				focusComposer();
			}
		});

		const previous = vscode.getState();
		if (previous) {
			state = {
				chat: previous.chat || { messages: [], busy: false, sessions: [] },
				composer: previous.composer || { attachments: [] },
				context: previous.context || { summary: [] },
				proposal: previous.proposal || { active: false }
			};
			render();
		}
		syncPromptHeight();

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
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

function isWebAttachmentInput(value: unknown): value is IBeamWebAttachmentInput {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as IBeamWebAttachmentInput;
	return typeof candidate.data === 'string'
		&& (!candidate.name || typeof candidate.name === 'string')
		&& (!candidate.mediaType || typeof candidate.mediaType === 'string');
}

function joinContextBlocks(...parts: Array<string | undefined>): string | undefined {
	const normalized = parts
		.map(part => part?.trim())
		.filter((part): part is string => Boolean(part));
	return normalized.length ? normalized.join('\n\n') : undefined;
}
