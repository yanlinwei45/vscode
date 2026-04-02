/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CursorAgentService } from './cursorAgentService';
import { CursorContextService } from './cursorContextService';
import { CursorProposalService } from './cursorProposalService';

export class CursorSidebarProvider extends vscode.Disposable implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;
	private pendingPrompt: string | undefined;
	private readonly localDisposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly service: CursorAgentService,
		private readonly contextService: CursorContextService,
		private readonly proposalService: CursorProposalService
	) {
		super(() => {
			vscode.Disposable.from(...this.localDisposables).dispose();
		});

		this.localDisposables.push(this.service.onDidChangeState(() => {
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
				const requestContext = await this.contextService.buildPromptContext();
				await this.service.sendUserMessage(message.prompt, requestContext);
				return;
			}

			if (message.type === 'command' && typeof message.command === 'string') {
				const args = Array.isArray(message.args) ? message.args : [];
				await vscode.commands.executeCommand(message.command, ...args);
				return;
			}

			if (message.type === 'ready') {
				this.postState();
				if (this.pendingPrompt) {
					this.view?.show?.(true);
					void this.view?.webview.postMessage({ type: 'seedPrompt', value: this.pendingPrompt });
					this.pendingPrompt = undefined;
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

	postState(): void {
		if (!this.view) {
			return;
		}

		void this.view.webview.postMessage({
			type: 'state',
			value: {
				chat: this.service.getState(),
				context: this.contextService.getState(),
				proposal: this.proposalService.getState()
			}
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = createNonce();
		const title = vscode.l10n.t('Independent Coding Agent');
		const subtitle = vscode.l10n.t('Separate from VS Code\'s built-in chat. Talks directly to your Anthropic-compatible endpoint.');
		const placeholder = vscode.l10n.t('Ask Cursor Agent to edit, explain, or reason about your code...');
		const hint = vscode.l10n.t('Uses ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL.');
		const emptyState = vscode.l10n.t('Start a fresh coding conversation here. This does not replace or patch the built-in VS Code chat experience.');
		const send = vscode.l10n.t('Send');
		const thinking = vscode.l10n.t('Thinking...');
		const sendSelection = vscode.l10n.t('Selection');
		const sendFile = vscode.l10n.t('Current File');
		const sendProblems = vscode.l10n.t('Problems');
		const newChat = vscode.l10n.t('New Chat');
		const openLogs = vscode.l10n.t('Logs');
		const insertLabel = vscode.l10n.t('Apply');
		const replaceLabel = vscode.l10n.t('Direct Replace');
		const previewInsertLabel = vscode.l10n.t('Preview Insert');
		const previewReplaceLabel = vscode.l10n.t('Preview Replace');
		const autoContextTitle = vscode.l10n.t('Auto Context');
		const proposalTitle = vscode.l10n.t('Proposed Edit');
		const acceptLabel = vscode.l10n.t('Accept');
		const rejectLabel = vscode.l10n.t('Reject');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Cursor Agent</title>
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
			padding: 12px 14px 10px;
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
		.badge {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 999px;
			padding: 4px 8px;
			font-size: 11px;
			opacity: 0.9;
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
		}
		.proposal {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 12px;
			padding: 10px 12px;
			background: color-mix(in srgb, var(--vscode-button-background) 8%, transparent);
			display: none;
		}
		.proposal.active {
			display: block;
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
		.eyebrow {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			opacity: 0.7;
			margin-bottom: 6px;
		}
		.title {
			font-size: 18px;
			font-weight: 700;
		}
		.subtitle {
			margin-top: 6px;
			font-size: 12px;
			opacity: 0.8;
			line-height: 1.5;
		}
		.toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 12px;
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
		.empty {
			padding: 14px;
			border: 1px dashed var(--vscode-panel-border);
			border-radius: 12px;
			opacity: 0.8;
			line-height: 1.5;
		}
		.message {
			padding: 12px;
			border-radius: 14px;
			border: 1px solid var(--vscode-panel-border);
			line-height: 1.5;
			font-size: 13px;
			box-shadow: 0 10px 20px rgba(0, 0, 0, 0.06);
		}
		.message.user {
			background: color-mix(in srgb, var(--vscode-button-background) 16%, transparent);
		}
		.message.assistant {
			background: color-mix(in srgb, var(--vscode-editor-background) 78%, var(--vscode-sideBar-background));
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
			gap: 8px;
			background: var(--vscode-editor-background);
		}
		textarea {
			width: 100%;
			min-height: 120px;
			resize: vertical;
			box-sizing: border-box;
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 10px;
			padding: 10px 12px;
			font: inherit;
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
		}
		.hint {
			font-size: 11px;
			opacity: 0.7;
		}
		.status {
			font-size: 11px;
			opacity: 0.75;
			text-align: right;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="header">
			<div class="eyebrow">Cursor Agent</div>
			<div class="title">${escapeHtml(title)}</div>
			<div class="subtitle">${escapeHtml(subtitle)}</div>
			<div class="toolbar">
				<button class="ghost" data-command="cursorAgent.sendSelection">${escapeHtml(sendSelection)}</button>
				<button class="ghost" data-command="cursorAgent.sendCurrentFile">${escapeHtml(sendFile)}</button>
				<button class="ghost" data-command="cursorAgent.sendProblems">${escapeHtml(sendProblems)}</button>
				<button class="ghost" data-command="cursorAgent.newChat">${escapeHtml(newChat)}</button>
				<button class="ghost" data-command="cursorAgent.showLogs">${escapeHtml(openLogs)}</button>
			</div>
		</div>
		<div class="meta">
			<div>
				<div class="proposal-title">${escapeHtml(autoContextTitle)}</div>
				<div id="contextBadges" class="badges"></div>
			</div>
			<div id="proposal" class="proposal">
				<div class="proposal-title">${escapeHtml(proposalTitle)}</div>
				<div id="proposalBody" class="proposal-body"></div>
				<div class="proposal-actions">
					<button id="acceptProposal">${escapeHtml(acceptLabel)}</button>
					<button id="rejectProposal">${escapeHtml(rejectLabel)}</button>
				</div>
			</div>
		</div>
		<div id="messages" class="messages"></div>
		<div class="composer">
			<textarea id="prompt" placeholder="${escapeHtml(placeholder)}"></textarea>
			<div class="actions">
				<div class="hint">${escapeHtml(hint)}</div>
				<div class="status" id="status"></div>
				<button id="send">${escapeHtml(send)}</button>
			</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const messagesEl = document.getElementById('messages');
		const promptEl = document.getElementById('prompt');
		const sendEl = document.getElementById('send');
		const statusEl = document.getElementById('status');
		const contextBadgesEl = document.getElementById('contextBadges');
		const proposalEl = document.getElementById('proposal');
		const proposalBodyEl = document.getElementById('proposalBody');
		const acceptProposalEl = document.getElementById('acceptProposal');
		const rejectProposalEl = document.getElementById('rejectProposal');
		const insertCommand = 'cursorAgent.insertCodeBlock';
		const replaceCommand = 'cursorAgent.replaceSelectionWithCodeBlock';
		const previewInsertCommand = 'cursorAgent.previewInsertCodeBlock';
		const previewReplaceCommand = 'cursorAgent.previewReplaceSelectionWithCodeBlock';
		let state = { chat: { messages: [], busy: false }, context: { summary: [] }, proposal: { active: false } };

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

		function renderContent(container, text) {
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
					container.appendChild(createCodeActions(body));
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

		function render() {
			messagesEl.innerHTML = '';
			contextBadgesEl.innerHTML = '';
			for (const item of state.context.summary || []) {
				const badge = document.createElement('div');
				badge.className = 'badge';
				badge.textContent = item;
				contextBadgesEl.appendChild(badge);
			}

			if (state.proposal.active) {
				proposalEl.className = 'proposal active';
				proposalBodyEl.textContent = (state.proposal.targetLabel || '') + (state.proposal.mode ? ' • ' + state.proposal.mode : '');
			} else {
				proposalEl.className = 'proposal';
				proposalBodyEl.textContent = '';
			}

			if (!state.chat.messages.length) {
				const empty = document.createElement('div');
				empty.className = 'empty';
				empty.textContent = ${JSON.stringify(emptyState)};
				messagesEl.appendChild(empty);
			}

			for (const message of state.chat.messages) {
				const item = document.createElement('div');
				item.className = 'message ' + message.role;
				if (message.content.startsWith('Error:')) {
					item.className += ' error';
				}

				const role = document.createElement('div');
				role.className = 'role';
				role.textContent = message.role;
				item.appendChild(role);

				const content = document.createElement('div');
				content.className = 'content';
				renderContent(content, message.content);
				item.appendChild(content);

				messagesEl.appendChild(item);
			}

			sendEl.disabled = state.chat.busy;
			sendEl.textContent = state.chat.busy ? ${JSON.stringify(thinking)} : ${JSON.stringify(send)};
			statusEl.textContent = state.chat.busy ? ${JSON.stringify(thinking)} : '';
			messagesEl.scrollTop = messagesEl.scrollHeight;
			vscode.setState(state);
		}

		function send() {
			const prompt = promptEl.value.trim();
			if (!prompt || state.chat.busy) {
				return;
			}
			vscode.postMessage({ type: 'send', prompt });
			promptEl.value = '';
		}

		sendEl.addEventListener('click', send);
		acceptProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'cursorAgent.acceptProposal' });
		});
		rejectProposalEl.addEventListener('click', () => {
			vscode.postMessage({ type: 'command', command: 'cursorAgent.rejectProposal' });
		});
		for (const action of document.querySelectorAll('[data-command]')) {
			action.addEventListener('click', () => {
				vscode.postMessage({ type: 'command', command: action.getAttribute('data-command') });
			});
		}
		promptEl.addEventListener('keydown', event => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				send();
			}
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'state') {
				state = message.value;
				render();
				return;
			}

			if (message.type === 'seedPrompt' && typeof message.value === 'string') {
				promptEl.value = message.value;
				promptEl.focus();
				promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
			}
		});

		const previous = vscode.getState();
		if (previous) {
			state = previous;
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
