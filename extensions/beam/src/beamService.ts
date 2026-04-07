/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { buildSystemPrompt } from './promptPolicy';
import { BeamToolService, type IBeamToolDefinition } from './toolService';

const STORAGE_KEY = 'beam.chatSessions.v2';
const ACTIVE_SESSION_STORAGE_KEY = 'beam.activeChatSessionId.v1';
const REQUEST_HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_TOOL_ROUNDS = 8;
const MAX_SESSIONS = 20;
const MAX_HISTORY_CHAR_BUDGET = 24000;
const MAX_MESSAGE_CHAR_BUDGET = 6000;
const MAX_REQUEST_CONTEXT_CHARS = 9000;
const MAX_SESSION_TITLE_LENGTH = 28;
const MAX_SESSION_PREVIEW_LENGTH = 90;

const DEFAULT_SESSION_TITLE = '\u65b0\u5bf9\u8bdd';

export interface IBeamChatMessage {
	readonly role: 'user' | 'assistant' | 'system' | 'tool';
	readonly content: string;
	readonly metadata?: {
		readonly toolName?: string;
	};
}

export interface IBeamChatState {
	readonly messages: readonly IBeamChatMessage[];
	readonly busy: boolean;
	readonly lastRequestContext?: string;
	readonly pendingToolNames?: readonly string[];
	readonly sessions: readonly IBeamChatSessionSummary[];
	readonly activeSessionId?: string;
	readonly activeSessionTitle?: string;
}

export interface IBeamChatSessionSummary {
	readonly id: string;
	readonly title: string;
	readonly preview: string;
	readonly updatedAt: number;
}

interface IAnthropicTextBlock {
	readonly type: 'text';
	readonly text: string;
}

interface IAnthropicToolUseBlock {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input?: unknown;
}

interface IAnthropicToolResultBlock {
	readonly type: 'tool_result';
	readonly tool_use_id: string;
	readonly content: string;
}

type IAnthropicContentBlock = IAnthropicTextBlock | IAnthropicToolUseBlock | IAnthropicToolResultBlock;

interface IAnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: readonly IAnthropicContentBlock[];
}

interface IAnthropicRequest {
	readonly model: string;
	readonly system?: string;
	readonly max_tokens: number;
	readonly messages: readonly IAnthropicMessage[];
	readonly tools?: readonly IBeamToolDefinition[];
	readonly tool_choice?: {
		readonly type: 'auto';
	};
}

interface IAnthropicResponse {
	readonly content?: readonly IAnthropicResponseBlock[];
	error?: {
		readonly message?: string;
	};
}

interface IAnthropicResponseTextBlock {
	readonly type: 'text';
	readonly text: string;
}

interface IAnthropicResponseToolUseBlock {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input?: unknown;
}

interface IAnthropicResponseOtherBlock {
	readonly type?: string;
	readonly text?: string;
}

type IAnthropicResponseBlock = IAnthropicResponseTextBlock | IAnthropicResponseToolUseBlock | IAnthropicResponseOtherBlock;

interface IJsonResponse<T> {
	readonly statusCode: number;
	readonly body: T;
}

interface IRequestTurn {
	readonly role: 'user' | 'assistant';
	readonly content: readonly IAnthropicContentBlock[];
}

interface IBeamChatSessionRecord {
	readonly id: string;
	readonly title: string;
	readonly messages: readonly IBeamChatMessage[];
	readonly lastRequestContext?: string;
	readonly updatedAt: number;
}

export class BeamService extends vscode.Disposable {

	private readonly _onDidChangeState = new vscode.EventEmitter<IBeamChatState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private messages: IBeamChatMessage[] = [];
	private busy = false;
	private lastRequestContext: string | undefined;
	private pendingToolNames: string[] = [];
	private sessions: IBeamChatSessionRecord[] = [];
	private activeSessionId: string | undefined;

	constructor(
		private readonly storage: vscode.Memento,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly toolService: BeamToolService
	) {
		super(() => {
			this._onDidChangeState.dispose();
		});

		this.restoreState();
		this.log(vscode.l10n.t('Beam \u5df2\u6062\u590d {0} \u4e2a\u5bf9\u8bdd\u3002', this.sessions.length));
	}

	getState(): IBeamChatState {
		const activeSession = this.getActiveSession();
		return {
			messages: this.messages,
			busy: this.busy,
			lastRequestContext: this.lastRequestContext,
			pendingToolNames: this.pendingToolNames,
			sessions: this.sessions.map(session => toSessionSummary(session)),
			activeSessionId: this.activeSessionId,
			activeSessionTitle: activeSession?.title
		};
	}

	reset(): void {
		if (this.busy) {
			return;
		}

		if (!this.messages.length && this.activeSessionId) {
			this.lastRequestContext = undefined;
			this.persistState();
			this._onDidChangeState.fire(this.getState());
			return;
		}

		const nextSession = this.createSessionRecord();
		this.sessions = [
			nextSession,
			...this.sessions.filter(session => session.id !== nextSession.id)
		].slice(0, MAX_SESSIONS);
		this.activeSessionId = nextSession.id;
		this.messages = [];
		this.lastRequestContext = undefined;
		this.persistState();
		this.log(vscode.l10n.t('Beam \u5df2\u65b0\u5efa\u5bf9\u8bdd\u3002'));
		this._onDidChangeState.fire(this.getState());
	}

	openSession(sessionId: string): void {
		if (this.busy || !sessionId) {
			return;
		}

		const session = this.sessions.find(item => item.id === sessionId);
		if (!session) {
			return;
		}

		this.activeSessionId = session.id;
		this.messages = [...session.messages];
		this.lastRequestContext = session.lastRequestContext;
		this.persistState();
		this._onDidChangeState.fire(this.getState());
	}

	async sendUserMessage(prompt: string, requestContext?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (this.busy || (!trimmed && !requestContext?.trim())) {
			return;
		}

		this.lastRequestContext = trimRequestContext(requestContext?.trim());
		this.pendingToolNames = [];
		this.messages = [...this.messages, { role: 'user', content: trimmed || vscode.l10n.t('\u8bf7\u7ed3\u5408\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u7ee7\u7eed\u3002') }];
		this.updateActiveSessionTitleFromPrompt(trimmed);
		this.busy = true;
		this.persistState();
		this._onDidChangeState.fire(this.getState());

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Beam \u6b63\u5728\u601d\u8003...'),
				cancellable: true
			}, async (progress, token) => {
				const content = await this.requestAssistantResponse(progress, token);
				this.messages = [...this.messages, { role: 'assistant', content }];
				this.persistState();
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\u3002');
			this.log(vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\uff1a{0}', message));
			this.messages = [...this.messages, { role: 'assistant', content: `\u9519\u8bef\uff1a${message}` }];
			this.persistState();
		} finally {
			this.busy = false;
			this.pendingToolNames = [];
			this._onDidChangeState.fire(this.getState());
		}
	}

	showOutput(preserveFocus?: boolean): void {
		this.outputChannel.show(preserveFocus);
	}

	private async requestAssistantResponse(
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken
	): Promise<string> {
		const { baseUrl, apiKey, authToken, model, systemPrompt } = this.getConfiguration();
		if (!apiKey && !authToken) {
			throw new Error(vscode.l10n.t('\u4f7f\u7528 Beam \u524d\uff0c\u8bf7\u5148\u8bbe\u7f6e ANTHROPIC_API_KEY \u6216 ANTHROPIC_AUTH_TOKEN\u3002'));
		}

		const endpoint = this.resolveEndpoint(baseUrl);
		const tools = this.toolService.getDefinitions();
		const turns = this.buildInitialTurns();

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			if (token?.isCancellationRequested) {
				throw new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5df2\u53d6\u6d88\u3002'));
			}

			progress?.report({
				message: round === 0 ? vscode.l10n.t('\u6b63\u5728\u8bf7\u6c42\u6a21\u578b\u54cd\u5e94...') : vscode.l10n.t('\u6b63\u5728\u7ee7\u7eed\u5904\u7406\u5de5\u5177\u7ed3\u679c...')
			});

			const body: IAnthropicRequest = {
				model,
				system: systemPrompt,
				max_tokens: 8192,
				messages: turns,
				tools,
				tool_choice: { type: 'auto' }
			};

			this.log(vscode.l10n.t('\u6b63\u5728\u5411 {0} \u53d1\u9001\u8bf7\u6c42\uff0c\u6a21\u578b\uff1a{1}\u3002', endpoint, model));
			const response = await postJson<IAnthropicResponse>(endpoint, {
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
				'x-api-key': apiKey ?? '',
				'authorization': authToken ? `Bearer ${authToken}` : ''
			}, body);
			this.log(vscode.l10n.t('Beam \u5df2\u6536\u5230\u54cd\u5e94\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode));

			const blocks = response.body.content ?? [];
			const assistantText = extractResponseText(response.body).trim();
			const toolUses = extractToolUses(blocks);

			if (!toolUses.length) {
				if (!assistantText) {
					throw new Error(response.body.error?.message || vscode.l10n.t('Beam \u8fd4\u56de\u4e86\u7a7a\u54cd\u5e94\u3002'));
				}

				return assistantText;
			}

			if (assistantText) {
				this.messages = [...this.messages, { role: 'assistant', content: assistantText }];
				this.persistState();
				this._onDidChangeState.fire(this.getState());
			}

			turns.push({
				role: 'assistant',
				content: blocks.map(block => {
					if (isTextResponseBlock(block)) {
						return { type: 'text', text: block.text };
					}

					if (isToolUseResponseBlock(block)) {
						return {
							type: 'tool_use',
							id: block.id,
							name: block.name,
							input: block.input
						};
					}

					return {
						type: 'text',
						text: ''
					};
				})
			});

			const toolResultBlocks: IAnthropicToolResultBlock[] = [];
			const pendingToolNames = toolUses.map(toolUse => toolUse.name);
			this.pendingToolNames = [...pendingToolNames];
			this._onDidChangeState.fire(this.getState());
			for (let index = 0; index < toolUses.length; index++) {
				if (token?.isCancellationRequested) {
					throw new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5df2\u53d6\u6d88\u3002'));
				}

				const toolUse = toolUses[index];
				progress?.report({
					message: vscode.l10n.t('\u6b63\u5728\u6267\u884c\uff1a{0} ({1}/{2})', toolUse.name, index + 1, toolUses.length)
				});
				const result = await this.toolService.invoke(toolUse.name, toolUse.input);
				const content = result.content || vscode.l10n.t('\u5de5\u5177\u6ca1\u6709\u8fd4\u56de\u4efb\u4f55\u8f93\u51fa\u3002');
				this.messages = [...this.messages, { role: 'tool', content, metadata: { toolName: result.toolName } }];
				this.pendingToolNames = pendingToolNames.slice(index + 1);
				toolResultBlocks.push({
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content
				});
				this._onDidChangeState.fire(this.getState());
			}

			this.pendingToolNames = [];
			this.persistState();
			this._onDidChangeState.fire(this.getState());

			turns.push({
				role: 'user',
				content: toolResultBlocks
			});
		}

		throw new Error(vscode.l10n.t('Beam \u8d85\u8fc7\u4e86\u6700\u5927\u5de5\u5177\u8c03\u7528\u8f6e\u6570\u3002'));
	}

	private getConfiguration(): {
		readonly baseUrl: string;
		readonly apiKey?: string;
		readonly authToken?: string;
		readonly model: string;
		readonly systemPrompt: string;
	} {
		const configuration = vscode.workspace.getConfiguration('beam');
		const configuredBaseUrl = configuration.get<string>('baseUrl')?.trim();
		const model = configuration.get<string>('model')?.trim() || 'claude-sonnet-4-20250514';
		const systemPrompt = buildSystemPrompt(configuration.get<string>('systemPrompt')?.trim());

		return {
			baseUrl: configuredBaseUrl || process.env['ANTHROPIC_BASE_URL']?.trim() || 'https://api.anthropic.com',
			apiKey: process.env['ANTHROPIC_API_KEY']?.trim() || undefined,
			authToken: process.env['ANTHROPIC_AUTH_TOKEN']?.trim() || undefined,
			model,
			systemPrompt
		};
	}

	private resolveEndpoint(baseUrl: string): string {
		const normalized = baseUrl.replace(/\/+$/, '');
		if (normalized.endsWith('/v1/messages')) {
			return normalized;
		}

		return `${normalized}/v1/messages`;
	}

	private restoreState(): void {
		const storedSessions = this.storage.get<IBeamChatSessionRecord[]>(STORAGE_KEY);
		const restoredSessions = Array.isArray(storedSessions)
			? storedSessions.filter(isBeamChatSessionRecord).slice(0, MAX_SESSIONS)
			: [];

		if (!restoredSessions.length) {
			const session = this.createSessionRecord();
			this.sessions = [session];
			this.activeSessionId = session.id;
			this.messages = [];
			this.lastRequestContext = undefined;
			return;
		}

		const storedActiveId = this.storage.get<string>(ACTIVE_SESSION_STORAGE_KEY);
		const activeSession = (storedActiveId ? restoredSessions.find(session => session.id === storedActiveId) : undefined) || restoredSessions[0];
		this.sessions = restoredSessions;
		this.activeSessionId = activeSession.id;
		this.messages = [...activeSession.messages];
		this.lastRequestContext = activeSession.lastRequestContext;
	}

	private persistState(): void {
		const activeSessionId = this.activeSessionId ?? this.sessions[0]?.id;
		if (!activeSessionId) {
			return;
		}

		const updatedActiveSession = this.createUpdatedActiveSession(activeSessionId);
		this.sessions = [
			updatedActiveSession,
			...this.sessions.filter(session => session.id !== activeSessionId)
		]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_SESSIONS);

		void this.storage.update(STORAGE_KEY, this.sessions);
		void this.storage.update(ACTIVE_SESSION_STORAGE_KEY, activeSessionId);
	}

	private buildInitialTurns(): IRequestTurn[] {
		const turns = this.messages
			.filter(message => message.role !== 'system' && message.role !== 'tool')
			.slice(-REQUEST_HISTORY_LIMIT)
			.map<IRequestTurn>((message, index, array) => {
				if (message.role === 'assistant') {
					return {
						role: 'assistant',
						content: [{ type: 'text', text: trimMessageContent(message.content) }]
					};
				}

				if (index === array.length - 1 && this.lastRequestContext) {
					return {
						role: 'user',
						content: [{
							type: 'text',
							text: `${trimMessageContent(message.content)}\n\n\u9644\u52a0\u4e0a\u4e0b\u6587\uff1a\n${this.lastRequestContext}`
						}]
					};
				}

				return {
					role: 'user',
					content: [{ type: 'text', text: trimMessageContent(message.content) }]
				};
			});

		return trimTurnsForRequest(turns, MAX_HISTORY_CHAR_BUDGET);
	}

	private getActiveSession(): IBeamChatSessionRecord | undefined {
		return this.activeSessionId ? this.sessions.find(session => session.id === this.activeSessionId) : undefined;
	}

	private createSessionRecord(title: string = DEFAULT_SESSION_TITLE): IBeamChatSessionRecord {
		return {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			title,
			messages: [],
			lastRequestContext: undefined,
			updatedAt: Date.now()
		};
	}

	private createUpdatedActiveSession(activeSessionId: string): IBeamChatSessionRecord {
		const existing = this.sessions.find(session => session.id === activeSessionId);
		return {
			id: activeSessionId,
			title: existing?.title || DEFAULT_SESSION_TITLE,
			messages: this.messages.slice(-300),
			lastRequestContext: this.lastRequestContext,
			updatedAt: Date.now()
		};
	}

	private updateActiveSessionTitleFromPrompt(prompt: string): void {
		if (!prompt || !this.activeSessionId) {
			return;
		}

		const nextTitle = createSessionTitle(prompt);
		this.sessions = this.sessions.map(session => {
			if (session.id !== this.activeSessionId || session.title !== DEFAULT_SESSION_TITLE) {
				return session;
			}

			return {
				...session,
				title: nextTitle
			};
		});
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function extractResponseText(response: IAnthropicResponse): string {
	return (response.content ?? [])
		.filter(isTextResponseBlock)
		.map(block => block.text)
		.join('');
}

function extractToolUses(blocks: readonly IAnthropicResponseBlock[]): IAnthropicToolUseBlock[] {
	return blocks
		.filter(isToolUseResponseBlock)
		.map(block => ({
			type: 'tool_use',
			id: block.id,
			name: block.name,
			input: block.input
		}));
}

function isTextResponseBlock(block: IAnthropicResponseBlock): block is IAnthropicResponseTextBlock {
	return block.type === 'text' && typeof block.text === 'string';
}

function isToolUseResponseBlock(block: IAnthropicResponseBlock): block is IAnthropicResponseToolUseBlock {
	return block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && 'name' in block && typeof block.name === 'string';
}

function isBeamChatMessage(value: IBeamChatMessage | undefined): value is IBeamChatMessage {
	return Boolean(
		value &&
		(value.role === 'user' || value.role === 'assistant' || value.role === 'system' || value.role === 'tool') &&
		typeof value.content === 'string'
	);
}

function isBeamChatSessionRecord(value: IBeamChatSessionRecord | undefined): value is IBeamChatSessionRecord {
	return Boolean(
		value &&
		typeof value.id === 'string' &&
		typeof value.title === 'string' &&
		Array.isArray(value.messages) &&
		value.messages.every(message => isBeamChatMessage(message)) &&
		typeof value.updatedAt === 'number'
	);
}

function toSessionSummary(session: IBeamChatSessionRecord): IBeamChatSessionSummary {
	const lastMessage = [...session.messages].reverse().find(message => message.role !== 'tool') || session.messages[session.messages.length - 1];
	return {
		id: session.id,
		title: session.title,
		preview: truncateForSummary(lastMessage?.content || ''),
		updatedAt: session.updatedAt
	};
}

function createSessionTitle(prompt: string): string {
	const singleLine = prompt.replace(/\s+/g, ' ').trim();
	if (!singleLine) {
		return DEFAULT_SESSION_TITLE;
	}

	return truncateTextValue(singleLine, MAX_SESSION_TITLE_LENGTH);
}

function trimMessageContent(value: string): string {
	return truncateTextValue(value.trim(), MAX_MESSAGE_CHAR_BUDGET);
}

function trimRequestContext(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return truncateTextValue(value, MAX_REQUEST_CONTEXT_CHARS);
}

function trimTurnsForRequest(turns: readonly IRequestTurn[], budget: number): IRequestTurn[] {
	const selected: IRequestTurn[] = [];
	let used = 0;

	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		const text = turn.content.map(block => block.type === 'text' ? block.text : '').join('\n');
		const length = text.length;
		if (selected.length && used + length > budget) {
			break;
		}

		selected.unshift(turn);
		used += length;
	}

	return selected;
}

function truncateForSummary(value: string): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine ? truncateTextValue(singleLine, MAX_SESSION_PREVIEW_LENGTH) : '';
}

function truncateTextValue(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 8))} ...`;
}

function postJson<T>(urlString: string, headers: Record<string, string>, body: unknown): Promise<IJsonResponse<T>> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlString);
		const payload = JSON.stringify(body);
		const requestHeaders: Record<string, string> = {
			...headers,
			'content-length': Buffer.byteLength(payload).toString()
		};

		for (const [key, value] of Object.entries(requestHeaders)) {
			if (!value) {
				delete requestHeaders[key];
			}
		}

		const transport = url.protocol === 'http:' ? http : https;
		const request = transport.request(url, {
			method: 'POST',
			headers: requestHeaders
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			response.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				if (!text) {
					reject(new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode ?? 0)));
					return;
				}

				try {
					const parsed = JSON.parse(text) as T;
					if ((response.statusCode ?? 500) >= 400) {
						const errorMessage = (parsed as IAnthropicResponse).error?.message;
						reject(new Error(errorMessage || vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode ?? 0)));
						return;
					}

					resolve({
						statusCode: response.statusCode ?? 200,
						body: parsed
					});
				} catch (error) {
					reject(error);
				}
			});
		});

		request.on('error', reject);
		request.setTimeout(REQUEST_TIMEOUT_MS, () => {
			request.destroy(new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u8d85\u65f6\uff0c\u5df2\u7b49\u5f85 {0} \u79d2\u3002', Math.floor(REQUEST_TIMEOUT_MS / 1000))));
		});
		request.write(payload);
		request.end();
	});
}
