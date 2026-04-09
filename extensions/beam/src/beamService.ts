/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import type { IBeamComposerResolvedAttachments } from './composerService';
import { buildInlineCompletionSystemPrompt, buildSystemPrompt } from './promptPolicy';
import { buildOpenAIChatCompletionMessages, getBeamModelOption, getBeamModelOptions, inferBeamProviderForModel, normalizeBeamModelSelection, normalizeBeamProvider, parseOpenAIFunctionArguments, resolveBeamModel, toOpenAIChatCompletionTools, type BeamProvider, type IBeamModelOption, type IBeamTurnContentBlock, type IRequestTurn } from './providerUtils';
import { BeamToolService, type IBeamToolDefinition } from './toolService';

const STORAGE_KEY = 'beam.chatSessions.v2';
const ACTIVE_SESSION_STORAGE_KEY = 'beam.activeChatSessionId.v1';
const SELECTED_MODEL_STORAGE_KEY = 'beam.selectedModel.v1';
const ACCESS_TOKEN_STORAGE_KEY = 'beam.accessToken.v2';
const REQUEST_HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_REQUEST_ATTEMPTS = 6;
const REQUEST_RETRY_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000];
const MAX_SESSIONS = 20;
const MAX_HISTORY_CHAR_BUDGET = 24000;
const MAX_MESSAGE_CHAR_BUDGET = 6000;
const MAX_REQUEST_CONTEXT_CHARS = 9000;
const MAX_SESSION_TITLE_LENGTH = 28;
const MAX_SESSION_PREVIEW_LENGTH = 90;
const DEFAULT_BEAM_BASE_URL = 'https://code.api.audiozen.cn/v1';

const DEFAULT_SESSION_TITLE = '\u65b0\u5bf9\u8bdd';

export interface IBeamChatMessage {
	readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking';
	readonly content: string;
	readonly metadata?: {
		readonly toolName?: string;
		readonly title?: string;
		readonly round?: number;
		readonly targetLabel?: string;
		readonly firstChangeLine?: number;
		readonly lastChangeLine?: number;
		readonly addedLines?: number;
		readonly deletedLines?: number;
		readonly modifiedLines?: number;
		readonly applied?: boolean;
	};
}

export interface IBeamChatState {
	readonly messages: readonly IBeamChatMessage[];
	readonly busy: boolean;
	readonly workingLabel?: string;
	readonly lastRequestContext?: string;
	readonly pendingToolNames?: readonly string[];
	readonly selectedModel: string;
	readonly availableModels: readonly IBeamModelOption[];
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

export interface IBeamTextRequestOptions {
	readonly silentAuth?: boolean;
	readonly maxTokens?: number;
}

interface IAnthropicBase64Source {
	readonly type: 'base64';
	readonly media_type: string;
	readonly data: string;
}

interface IAnthropicTextBlock {
	readonly type: 'text';
	readonly text: string;
}

interface IAnthropicImageBlock {
	readonly type: 'image';
	readonly source: IAnthropicBase64Source;
}

interface IAnthropicDocumentBlock {
	readonly type: 'document';
	readonly source: IAnthropicBase64Source;
	readonly title?: string;
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

type IAnthropicContentBlock =
	| IAnthropicTextBlock
	| IAnthropicImageBlock
	| IAnthropicDocumentBlock
	| IAnthropicToolUseBlock
	| IAnthropicToolResultBlock;

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

interface IOpenAIChatCompletionMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content?: string;
	readonly tool_calls?: readonly IOpenAIChatCompletionToolCall[];
	readonly tool_call_id?: string;
}

interface IOpenAIChatCompletionToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

interface IOpenAIChatCompletionToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: {
			readonly type: 'object';
			readonly properties: Record<string, unknown>;
			readonly required?: readonly string[];
		};
	};
}

interface IOpenAIChatCompletionsRequest {
	readonly model: string;
	readonly messages: readonly IOpenAIChatCompletionMessage[];
	readonly tools?: readonly IOpenAIChatCompletionToolDefinition[];
	readonly tool_choice?: 'auto';
	readonly max_tokens?: number;
}

interface IOpenAIChatCompletionsResponse {
	readonly choices?: readonly IOpenAIChatCompletionChoice[];
	error?: {
		readonly message?: string;
	};
}

interface IOpenAIChatCompletionChoice {
	readonly message?: IOpenAIChatCompletionMessage;
}

interface IJsonResponse<T> {
	readonly statusCode: number;
	readonly body: T;
}

interface IProviderToolUse {
	readonly id: string;
	readonly name: string;
	readonly input?: unknown;
}

interface IBeamProviderConfiguration {
	readonly provider: BeamProvider;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly authToken?: string;
	readonly model: string;
	readonly requestModel: string;
	readonly anthropicBeta?: string;
	readonly systemPrompt: string;
	readonly configuredProvider: BeamProvider;
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
	private workingLabel: string | undefined;
	private lastRequestContext: string | undefined;
	private pendingToolNames: string[] = [];
	private sessions: IBeamChatSessionRecord[] = [];
	private activeSessionId: string | undefined;
	private selectedModel: string | undefined;
	private accessToken: string | undefined;
	private accessTokenPrompt: Promise<string | undefined> | undefined;
	private activeRequestCancellation = new vscode.CancellationTokenSource();

	constructor(
		private readonly storage: vscode.Memento,
		private readonly globalState: vscode.Memento,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly toolService: BeamToolService
	) {
		super(() => {
			this._onDidChangeState.dispose();
		});

		this.restoreState();
		this.accessToken = normalizeStoredAccessToken(this.globalState.get<string>(ACCESS_TOKEN_STORAGE_KEY));
		this.log(vscode.l10n.t('Beam \u5df2\u6062\u590d {0} \u4e2a\u5bf9\u8bdd\u3002', this.sessions.length));
	}

	getState(): IBeamChatState {
		const activeSession = this.getActiveSession();
		const configuration = this.getConfiguration();
		return {
			messages: this.messages,
			busy: this.busy,
			workingLabel: this.workingLabel,
			lastRequestContext: this.lastRequestContext,
			pendingToolNames: this.pendingToolNames,
			selectedModel: configuration.model,
			availableModels: this.getAvailableModels(configuration),
			sessions: this.sessions.map(session => toSessionSummary(session)),
			activeSessionId: this.activeSessionId,
			activeSessionTitle: activeSession?.title
		};
	}

	async setSelectedModel(model: string): Promise<void> {
		const normalized = normalizeBeamModelSelection(model);
		if (!normalized) {
			return;
		}

		this.selectedModel = normalized;
		void this.storage.update(SELECTED_MODEL_STORAGE_KEY, normalized);
		this._onDidChangeState.fire(this.getState());
	}

	async refreshModels(): Promise<void> {
		// Beam intentionally uses a built-in static model list.
		this._onDidChangeState.fire(this.getState());
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
		await this.sendUserMessageWithAttachments(prompt, requestContext);
	}

	async requestInlineCompletion(prompt: string, options?: IBeamTextRequestOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
		const trimmed = prompt.trim();
		if (!trimmed) {
			return undefined;
		}

		const configuration = await this.getRequestConfiguration(options);
		if (!configuration) {
			return undefined;
		}

		const inlineConfiguration: IBeamProviderConfiguration = {
			...configuration,
			systemPrompt: buildInlineCompletionSystemPrompt(vscode.workspace.getConfiguration('beam').get<string>('systemPrompt')?.trim())
		};

		const turns: IRequestTurn[] = [{
			role: 'user',
			content: [{
				type: 'text',
				text: trimmed
			}]
		}];

		const content = await this.requestPlainTextResponse(inlineConfiguration, turns, options, token);
		const normalized = normalizeInlineCompletionResponse(content);
		return normalized || undefined;
	}

	async sendUserMessageWithAttachments(prompt: string, requestContext?: string, attachments?: IBeamComposerResolvedAttachments): Promise<void> {
		const trimmed = prompt.trim();
		const hasAttachmentPayload = Boolean(attachments?.context || attachments?.images.length || attachments?.documents.length);
		if (this.busy || (!trimmed && !requestContext?.trim() && !hasAttachmentPayload)) {
			return;
		}

		const configuration = await this.getRequestConfiguration();
		if (!configuration) {
			return;
		}

		this.lastRequestContext = trimRequestContext(requestContext?.trim());
		this.pendingToolNames = [];
		this.workingLabel = vscode.l10n.t('正在分析需求并规划下一步...');
		this.messages = [...this.messages, { role: 'user', content: trimmed || vscode.l10n.t('\u8bf7\u7ed3\u5408\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u7ee7\u7eed\u3002') }];
		this.updateActiveSessionTitleFromPrompt(trimmed);
		this.busy = true;
		this.activeRequestCancellation.dispose();
		this.activeRequestCancellation = new vscode.CancellationTokenSource();
		this.persistState();
		this._onDidChangeState.fire(this.getState());

		try {
			const content = await this.requestAssistantResponse(configuration, undefined, this.activeRequestCancellation.token, attachments);
			this.messages = [...this.messages, { role: 'assistant', content }];
			this.persistState();
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\u3002');
			const message = toUserFacingBeamErrorMessage(rawMessage);
			if (this.activeRequestCancellation.token.isCancellationRequested && /已取消/.test(message)) {
				this.log(vscode.l10n.t('Beam 请求已由用户取消。'));
				return;
			}
			this.log(vscode.l10n.t('Beam 请求失败：{0}', rawMessage));
			this.messages = [...this.messages, { role: 'assistant', content: message }];
			this.persistState();
		} finally {
			this.busy = false;
			this.workingLabel = undefined;
			this.pendingToolNames = [];
			this.activeRequestCancellation.dispose();
			this.activeRequestCancellation = new vscode.CancellationTokenSource();
			this._onDidChangeState.fire(this.getState());
		}
	}

	cancelActiveRequest(): void {
		if (!this.busy || this.activeRequestCancellation.token.isCancellationRequested) {
			return;
		}

		this.activeRequestCancellation.cancel();
	}

	showOutput(preserveFocus?: boolean): void {
		this.outputChannel.show(preserveFocus);
	}

	private async requestAssistantResponse(
		configuration: IBeamProviderConfiguration,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		attachments?: IBeamComposerResolvedAttachments
	): Promise<string> {
		if (configuration.provider === 'openai') {
			return this.requestOpenAIResponse(configuration, progress, token, attachments);
		}

		return this.requestAnthropicResponse(configuration, progress, token, attachments);
	}

	private async requestPlainTextResponse(
		configuration: IBeamProviderConfiguration,
		turns: readonly IRequestTurn[],
		options?: IBeamTextRequestOptions,
		token?: vscode.CancellationToken
	): Promise<string> {
		if (configuration.provider === 'openai') {
			return this.requestOpenAIPlainTextResponse(configuration, turns, options, token);
		}

		return this.requestAnthropicPlainTextResponse(configuration, turns, options, token);
	}

	private async requestAnthropicResponse(
		configuration: IBeamProviderConfiguration,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		attachments?: IBeamComposerResolvedAttachments
	): Promise<string> {
		const { baseUrl, apiKey, authToken, requestModel: model, anthropicBeta, systemPrompt } = configuration;
		if (!apiKey && !authToken) {
			throw new Error(vscode.l10n.t('使用 Beam 前，请先输入访问令牌。'));
		}

		const endpoint = this.resolveAnthropicEndpoint(baseUrl);
		const tools = this.toolService.getDefinitions();
		const turns = this.buildInitialTurns(attachments);

		for (let round = 0; ; round++) {
			this.throwIfCancelled(token);
			this.reportModelProgress(progress, round);

			const body: IAnthropicRequest = {
				model,
				system: systemPrompt,
				max_tokens: 8192,
				messages: turns.map(turn => ({
					role: turn.role,
					content: turn.content.map(toAnthropicContentBlock)
				})),
				tools,
				tool_choice: { type: 'auto' }
			};

			this.log(vscode.l10n.t('\u6b63\u5728\u5411 {0} \u53d1\u9001\u8bf7\u6c42\uff0c\u6a21\u578b\uff1a{1}\u3002', endpoint, model));
			const response = await this.postJsonWithRetry<IAnthropicResponse>(
				endpoint,
				{
					'content-type': 'application/json',
					'anthropic-version': '2023-06-01',
					'anthropic-beta': anthropicBeta ?? '',
					'x-api-key': apiKey ?? '',
					'authorization': authToken ? `Bearer ${authToken}` : ''
				},
				body,
				token,
				progress
			);
			this.log(vscode.l10n.t('Beam \u5df2\u6536\u5230\u54cd\u5e94\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode));
			this.throwIfCancelled(token);

			const blocks = response.body.content ?? [];
			const assistantText = extractAnthropicResponseText(response.body).trim();
			const toolUses = extractAnthropicToolUses(blocks);

			if (!toolUses.length) {
				this.throwIfCancelled(token);
				if (!assistantText) {
					throw new Error(response.body.error?.message || vscode.l10n.t('Beam \u8fd4\u56de\u4e86\u7a7a\u54cd\u5e94\u3002'));
				}

				return assistantText;
			}

			this.recordAssistantProgress(assistantText, round);
			turns.push({
				role: 'assistant',
				content: blocks.map(block => {
					if (isAnthropicTextResponseBlock(block)) {
						return { type: 'text', text: block.text };
					}

					if (isAnthropicToolUseResponseBlock(block)) {
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

			const toolResultBlocks = await this.invokeTools(toolUses, round, progress, token);
			turns.push({
				role: 'user',
				content: toolResultBlocks.map(result => ({
					type: 'tool_result',
					toolUseId: result.id,
					content: result.content
				}))
			});
		}
	}

	private async requestAnthropicPlainTextResponse(
		configuration: IBeamProviderConfiguration,
		turns: readonly IRequestTurn[],
		options?: IBeamTextRequestOptions,
		token?: vscode.CancellationToken
	): Promise<string> {
		const { baseUrl, apiKey, authToken, requestModel: model, anthropicBeta, systemPrompt } = configuration;
		if (!apiKey && !authToken) {
			throw new Error(vscode.l10n.t('使用 Beam 前，请先输入访问令牌。'));
		}

		const endpoint = this.resolveAnthropicEndpoint(baseUrl);
		const body: IAnthropicRequest = {
			model,
			system: systemPrompt,
			max_tokens: options?.maxTokens ?? 512,
			messages: turns.map(turn => ({
				role: turn.role,
				content: turn.content.map(toAnthropicContentBlock)
			}))
		};

		this.log(vscode.l10n.t('正在向 {0} 发送 Beam 文本请求，模型：{1}。', endpoint, model));
		const response = await this.postJsonWithRetry<IAnthropicResponse>(
			endpoint,
			{
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
				'anthropic-beta': anthropicBeta ?? '',
				'x-api-key': apiKey ?? '',
				'authorization': authToken ? `Bearer ${authToken}` : ''
			},
			body,
			token
		);
		this.throwIfCancelled(token);
		const assistantText = extractAnthropicResponseText(response.body).trim();
		if (!assistantText) {
			throw new Error(response.body.error?.message || vscode.l10n.t('Beam 返回了空响应。'));
		}

		return assistantText;
	}

	private async requestOpenAIResponse(
		configuration: IBeamProviderConfiguration,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		attachments?: IBeamComposerResolvedAttachments
	): Promise<string> {
		const { baseUrl, apiKey, requestModel: model, systemPrompt } = configuration;
		if (!apiKey) {
			throw new Error(vscode.l10n.t('使用 Beam 前，请先输入访问令牌。'));
		}

		const endpoint = this.resolveOpenAIChatCompletionsEndpoint(baseUrl);
		const tools = toOpenAIChatCompletionTools(this.toolService.getDefinitions());
		const turns = this.buildInitialTurns(attachments);

		for (let round = 0; ; round++) {
			this.throwIfCancelled(token);
			this.reportModelProgress(progress, round);

			const body: IOpenAIChatCompletionsRequest = {
				model,
				messages: buildOpenAIChatCompletionMessages(systemPrompt, turns),
				tools,
				tool_choice: 'auto'
			};

			this.log(vscode.l10n.t('\u6b63\u5728\u5411 {0} \u53d1\u9001 OpenAI Chat Completions \u8bf7\u6c42\uff0c\u6a21\u578b\uff1a{1}\u3002', endpoint, model));
			const response = await this.postJsonWithRetry<IOpenAIChatCompletionsResponse>(
				endpoint,
				{
					'content-type': 'application/json',
					'authorization': `Bearer ${apiKey}`
				},
				body,
				token,
				progress
			);
			this.log(vscode.l10n.t('Beam \u5df2\u6536\u5230 OpenAI \u54cd\u5e94\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode));
			this.throwIfCancelled(token);

			const message = response.body.choices?.[0]?.message;
			const assistantText = extractOpenAIChatCompletionText(message).trim();
			const toolUses = extractOpenAIChatCompletionToolUses(message);

			if (!toolUses.length) {
				this.throwIfCancelled(token);
				if (!assistantText) {
					throw new Error(response.body.error?.message || vscode.l10n.t('Beam \u8fd4\u56de\u4e86\u7a7a\u54cd\u5e94\u3002'));
				}

				return assistantText;
			}

			this.recordAssistantProgress(assistantText, round);
			turns.push({
				role: 'assistant',
				content: toBeamOpenAIChatCompletionBlocks(message)
			});

			const toolResultBlocks = await this.invokeTools(toolUses, round, progress, token);
			turns.push({
				role: 'user',
				content: toolResultBlocks.map(result => ({
					type: 'tool_result',
					toolUseId: result.id,
					content: result.content
				}))
			});
		}
	}

	private async requestOpenAIPlainTextResponse(
		configuration: IBeamProviderConfiguration,
		turns: readonly IRequestTurn[],
		options?: IBeamTextRequestOptions,
		token?: vscode.CancellationToken
	): Promise<string> {
		const { baseUrl, apiKey, requestModel: model, systemPrompt } = configuration;
		if (!apiKey) {
			throw new Error(vscode.l10n.t('使用 Beam 前，请先输入访问令牌。'));
		}

		const endpoint = this.resolveOpenAIChatCompletionsEndpoint(baseUrl);
		const body: IOpenAIChatCompletionsRequest = {
			model,
			messages: buildOpenAIChatCompletionMessages(systemPrompt, turns),
			max_tokens: options?.maxTokens ?? 512
		};

		this.log(vscode.l10n.t('正在向 {0} 发送 Beam OpenAI 文本请求，模型：{1}。', endpoint, model));
		const response = await this.postJsonWithRetry<IOpenAIChatCompletionsResponse>(
			endpoint,
			{
				'content-type': 'application/json',
				'authorization': `Bearer ${apiKey}`
			},
			body,
			token
		);
		this.throwIfCancelled(token);
		const assistantText = extractOpenAIChatCompletionText(response.body.choices?.[0]?.message).trim();
		if (!assistantText) {
			throw new Error(response.body.error?.message || vscode.l10n.t('Beam 返回了空响应。'));
		}

		return assistantText;
	}

	private getConfiguration(): IBeamProviderConfiguration {
		const configuration = vscode.workspace.getConfiguration('beam');
		const configuredProvider = normalizeBeamProvider(configuration.get<string>('provider'));
		const configuredBaseUrl = configuration.get<string>('baseUrl')?.trim() || DEFAULT_BEAM_BASE_URL;
		const configuredModel = this.selectedModel || configuration.get<string>('model')?.trim();
		const systemPrompt = buildSystemPrompt(configuration.get<string>('systemPrompt')?.trim());
		const inferredProvider = inferBeamProviderForModel(configuredModel, configuredProvider);
		return this.getConfigurationForProvider(inferredProvider, configuredProvider, configuredBaseUrl, configuredModel, systemPrompt);
	}

	private async getRequestConfiguration(options?: IBeamTextRequestOptions): Promise<IBeamProviderConfiguration | undefined> {
		const configuration = this.getConfiguration();
		const accessToken = await this.ensureAccessToken(options?.silentAuth);
		if (!accessToken) {
			return undefined;
		}

		if (configuration.provider === 'openai') {
			return {
				...configuration,
				apiKey: accessToken,
				authToken: undefined
			};
		}

		return {
			...configuration,
			apiKey: accessToken,
			authToken: accessToken
		};
	}

	private getConfigurationForProvider(
		provider: BeamProvider,
		configuredProvider: BeamProvider,
		configuredBaseUrl: string | undefined,
		configuredModel: string | undefined,
		systemPrompt: string
	): IBeamProviderConfiguration {
		if (provider === 'openai') {
			const baseUrl = configuredBaseUrl || DEFAULT_BEAM_BASE_URL;
			const resolvedModel = resolveBeamModel(provider, configuredModel, undefined);
			const modelOption = getBeamModelOption(resolvedModel);
			return {
				provider,
				configuredProvider,
				baseUrl,
				model: modelOption?.id ?? resolvedModel,
				requestModel: modelOption?.requestModel ?? resolvedModel,
				systemPrompt
			};
		}

		const baseUrl = configuredBaseUrl || DEFAULT_BEAM_BASE_URL;
		const resolvedModel = resolveBeamModel(provider, configuredModel, undefined);
		const modelOption = getBeamModelOption(resolvedModel);
		return {
			provider,
			configuredProvider,
			baseUrl,
			model: modelOption?.id ?? resolvedModel,
			requestModel: modelOption?.requestModel ?? resolvedModel,
			anthropicBeta: modelOption?.anthropicBeta,
			systemPrompt
		};
	}

	async configureAccessToken(): Promise<void> {
		const token = await this.promptForAccessToken();
		if (!token) {
			return;
		}

		void vscode.window.showInformationMessage(vscode.l10n.t('Beam 访问令牌已保存。'));
	}

	private getAvailableModels(_configuration: IBeamProviderConfiguration): readonly IBeamModelOption[] {
		return getBeamModelOptions();
	}

	private async ensureAccessToken(silent?: boolean): Promise<string | undefined> {
		if (this.accessToken) {
			return this.accessToken;
		}

		const storedToken = normalizeStoredAccessToken(this.globalState.get<string>(ACCESS_TOKEN_STORAGE_KEY));
		if (storedToken) {
			this.accessToken = storedToken;
			return storedToken;
		}

		if (silent) {
			return undefined;
		}

		return this.promptForAccessToken();
	}

	private async promptForAccessToken(): Promise<string | undefined> {
		if (!this.accessTokenPrompt) {
			this.accessTokenPrompt = (async () => {
				const token = await vscode.window.showInputBox({
					prompt: vscode.l10n.t('请输入 Beam 访问令牌。保存后即可继续发送请求。'),
					placeHolder: vscode.l10n.t('输入你的访问令牌'),
					password: true,
					ignoreFocusOut: true
				});
				const normalizedToken = normalizeStoredAccessToken(token);
				if (!normalizedToken) {
					return undefined;
				}

				this.accessToken = normalizedToken;
				await this.globalState.update(ACCESS_TOKEN_STORAGE_KEY, normalizedToken);
				return normalizedToken;
			})().finally(() => {
				this.accessTokenPrompt = undefined;
			});
		}

		return this.accessTokenPrompt;
	}

	private resolveAnthropicEndpoint(baseUrl: string): string {
		const normalized = baseUrl.replace(/\/+$/, '');
		if (normalized.endsWith('/v1/messages')) {
			return normalized;
		}

		if (normalized.endsWith('/v1')) {
			return `${normalized}/messages`;
		}

		return `${normalized}/v1/messages`;
	}

	private resolveOpenAIChatCompletionsEndpoint(baseUrl: string): string {
		const normalized = baseUrl.replace(/\/+$/, '');
		if (normalized.endsWith('/v1/chat/completions')) {
			return normalized;
		}

		if (normalized.endsWith('/v1')) {
			return `${normalized}/chat/completions`;
		}

		return `${normalized}/v1/chat/completions`;
	}

	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) {
			throw new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5df2\u53d6\u6d88\u3002'));
		}
	}

	private reportModelProgress(progress: vscode.Progress<{ message?: string; increment?: number }> | undefined, round: number): void {
		const message = round === 0
			? vscode.l10n.t('正在分析需求并决定先检查什么...')
			: vscode.l10n.t('正在根据刚才的结果继续判断下一步...');
		this.workingLabel = message;
		progress?.report({ message });
		this._onDidChangeState.fire(this.getState());
	}

	private recordAssistantProgress(assistantText: string, round: number): void {
		if (!assistantText) {
			return;
		}

		this.messages = [...this.messages, {
			role: 'thinking',
			content: assistantText,
			metadata: {
				title: createThinkingTitle(assistantText, round),
				round: round + 1
			}
		}];
		this.persistState();
		this._onDidChangeState.fire(this.getState());
	}

	private async invokeTools(
		toolUses: readonly IProviderToolUse[],
		round: number,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken
	): Promise<Array<{ readonly id: string; readonly content: string }>> {
		const toolResultBlocks: Array<{ readonly id: string; readonly content: string }> = [];
		const pendingToolNames = toolUses.map(toolUse => toolUse.name);
		this.pendingToolNames = [...pendingToolNames];
		this._onDidChangeState.fire(this.getState());

		for (let index = 0; index < toolUses.length; index++) {
			this.throwIfCancelled(token);

			const toolUse = toolUses[index];
			const toolDisplayName = getToolDisplayName(toolUse.name);
			const progressMessage = vscode.l10n.t('正在执行：{0} ({1}/{2})', toolDisplayName, index + 1, toolUses.length);
			this.workingLabel = progressMessage;
			progress?.report({ message: progressMessage });
			this._onDidChangeState.fire(this.getState());
			const result = await this.toolService.invoke(toolUse.name, toolUse.input);
			this.throwIfCancelled(token);
			const content = result.content || vscode.l10n.t('\u5de5\u5177\u6ca1\u6709\u8fd4\u56de\u4efb\u4f55\u8f93\u51fa\u3002');
			this.messages = [...this.messages, {
				role: 'tool',
				content,
				metadata: {
					toolName: result.toolName,
					title: toolDisplayName,
					round: round + 1
				}
			}];
			this.pendingToolNames = pendingToolNames.slice(index + 1);
			toolResultBlocks.push({
				id: toolUse.id,
				content
			});
			this.persistState();
			this._onDidChangeState.fire(this.getState());
		}

		this.workingLabel = vscode.l10n.t('正在整理检查结果并准备下一步...');
		this.pendingToolNames = [];
		this._onDidChangeState.fire(this.getState());
		return toolResultBlocks;
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
		this.selectedModel = normalizeBeamModelSelection(this.storage.get<string>(SELECTED_MODEL_STORAGE_KEY));
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

	private async postJsonWithRetry<T>(
		urlString: string,
		headers: Record<string, string>,
		body: unknown,
		token?: vscode.CancellationToken,
		progress?: vscode.Progress<{ message?: string; increment?: number }>
	): Promise<IJsonResponse<T>> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
			this.throwIfCancelled(token);
			try {
				return await postJson<T>(urlString, headers, body, token);
			} catch (error) {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				lastError = normalizedError;
				if (!shouldRetryBeamRequest(normalizedError) || attempt >= MAX_REQUEST_ATTEMPTS - 1) {
					break;
				}

				const retryIndex = attempt + 1;
				const waitMs = REQUEST_RETRY_BACKOFF_MS[Math.min(attempt, REQUEST_RETRY_BACKOFF_MS.length - 1)] ?? REQUEST_RETRY_BACKOFF_MS[REQUEST_RETRY_BACKOFF_MS.length - 1];
				const retryMessage = vscode.l10n.t('服务暂时不可用，正在自动重试 ({0}/{1})...', retryIndex, MAX_REQUEST_ATTEMPTS - 1);
				this.workingLabel = retryMessage;
				progress?.report({ message: retryMessage });
				this._onDidChangeState.fire(this.getState());
				this.log(vscode.l10n.t('Beam 请求异常，准备第 {0} 次重试：{1}', retryIndex, normalizedError.message));
				await sleep(waitMs, token);
			}
		}

		if (lastError && isGatewayRetryableError(lastError.message)) {
			throw new Error(vscode.l10n.t('Beam 服务暂时不可用，已自动重试多次。请稍后再试。'));
		}

		if (lastError) {
			throw new Error(toUserFacingBeamErrorMessage(lastError.message));
		}

		throw new Error(vscode.l10n.t('Beam 请求失败。'));
	}

	private buildInitialTurns(attachments?: IBeamComposerResolvedAttachments): IRequestTurn[] {
		const turns = this.messages
			.filter(message => message.role !== 'system' && message.role !== 'tool' && message.role !== 'thinking')
			.slice(-REQUEST_HISTORY_LIMIT)
			.map<IRequestTurn>((message, index, array) => {
				if (message.role === 'assistant') {
					return {
						role: 'assistant',
						content: [{ type: 'text', text: trimMessageContent(message.content) }]
					};
				}

				return {
					role: 'user',
					content: this.buildUserTurnContent(message.content, index === array.length - 1 ? attachments : undefined)
				};
			});

		return trimTurnsForRequest(turns, MAX_HISTORY_CHAR_BUDGET);
	}

	private buildUserTurnContent(prompt: string, attachments?: IBeamComposerResolvedAttachments): IBeamTurnContentBlock[] {
		const blocks: IBeamTurnContentBlock[] = [];
		const textParts = [trimMessageContent(prompt)];
		const context = attachments?.context ?? this.lastRequestContext;
		if (context) {
			textParts.push(`\u9644\u52a0\u4e0a\u4e0b\u6587\uff1a\n${context}`);
		}

		const text = textParts.filter(Boolean).join('\n\n').trim();
		if (text) {
			blocks.push({
				type: 'text',
				text
			});
		}

		for (const image of attachments?.images ?? []) {
			blocks.push({
				type: 'image',
				mediaType: image.mediaType,
				data: image.data
			});
		}

		for (const document of attachments?.documents ?? []) {
			blocks.push({
				type: 'document',
				title: document.label,
				mediaType: document.mediaType,
				data: document.data
			});
		}

		return blocks.length ? blocks : [{ type: 'text', text: vscode.l10n.t('\u8bf7\u7ed3\u5408\u5df2\u9644\u52a0\u7684\u4e0a\u4e0b\u6587\u7ee7\u7eed\u3002') }];
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

function toAnthropicContentBlock(block: IBeamTurnContentBlock): IAnthropicContentBlock {
	switch (block.type) {
		case 'text':
			return {
				type: 'text',
				text: block.text
			};
		case 'image':
			return {
				type: 'image',
				source: {
					type: 'base64',
					media_type: block.mediaType,
					data: block.data
				}
			};
		case 'document':
			return {
				type: 'document',
				title: block.title,
				source: {
					type: 'base64',
					media_type: block.mediaType,
					data: block.data
				}
			};
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input
			};
		case 'tool_result':
			return {
				type: 'tool_result',
				tool_use_id: block.toolUseId,
				content: block.content
			};
	}
}

function extractAnthropicResponseText(response: IAnthropicResponse): string {
	return (response.content ?? [])
		.filter(isAnthropicTextResponseBlock)
		.map(block => block.text)
		.join('');
}

function extractAnthropicToolUses(blocks: readonly IAnthropicResponseBlock[]): IProviderToolUse[] {
	return blocks
		.filter(isAnthropicToolUseResponseBlock)
		.map(block => ({
			id: block.id,
			name: block.name,
			input: block.input
		}));
}

function isAnthropicTextResponseBlock(block: IAnthropicResponseBlock): block is IAnthropicResponseTextBlock {
	return block.type === 'text' && typeof block.text === 'string';
}

function isAnthropicToolUseResponseBlock(block: IAnthropicResponseBlock): block is IAnthropicResponseToolUseBlock {
	return block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && 'name' in block && typeof block.name === 'string';
}

function extractOpenAIChatCompletionText(message: IOpenAIChatCompletionMessage | undefined): string {
	return typeof message?.content === 'string' ? message.content : '';
}

function extractOpenAIChatCompletionToolUses(message: IOpenAIChatCompletionMessage | undefined): IProviderToolUse[] {
	return (message?.tool_calls ?? [])
		.map(call => ({
			id: call.id,
			name: call.function.name,
			input: parseOpenAIFunctionArguments(call.function.arguments)
		}))
		.filter(item => Boolean(item.name));
}

function toBeamOpenAIChatCompletionBlocks(message: IOpenAIChatCompletionMessage | undefined): IBeamTurnContentBlock[] {
	const blocks: IBeamTurnContentBlock[] = [];
	if (typeof message?.content === 'string' && message.content) {
		blocks.push({
			type: 'text',
			text: message.content
		});
	}

	for (const call of message?.tool_calls ?? []) {
			blocks.push({
				type: 'tool_use',
				id: call.id,
				name: call.function.name,
				input: parseOpenAIFunctionArguments(call.function.arguments)
			});
	}

	return blocks;
}

function isBeamChatMessage(value: IBeamChatMessage | undefined): value is IBeamChatMessage {
	return Boolean(
		value &&
		(value.role === 'user' || value.role === 'assistant' || value.role === 'system' || value.role === 'tool' || value.role === 'thinking') &&
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
	const lastMessage = [...session.messages].reverse().find(message => message.role !== 'tool' && message.role !== 'thinking') || session.messages[session.messages.length - 1];
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

function createThinkingTitle(text: string, round: number): string {
	const singleLine = text.replace(/\s+/g, ' ').trim();
	if (!singleLine) {
		return vscode.l10n.t('第 {0} 轮分析', round + 1);
	}

	const firstSentence = singleLine.split(/(?<=[。！？!?])/)[0]?.trim() || singleLine;
	return truncateTextValue(firstSentence, 42);
}

function getToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'get_active_editor_context':
			return vscode.l10n.t('读取当前上下文');
		case 'read_file':
			return vscode.l10n.t('读取文件');
		case 'list_directory':
			return vscode.l10n.t('列出目录');
		case 'search_workspace':
			return vscode.l10n.t('搜索工作区');
		case 'get_diagnostics':
			return vscode.l10n.t('获取诊断信息');
		case 'open_file':
			return vscode.l10n.t('打开文件');
		case 'select_editor_range':
			return vscode.l10n.t('选中范围');
		case 'select_current_function':
			return vscode.l10n.t('选中当前函数');
		case 'select_current_block':
			return vscode.l10n.t('扩展当前代码块');
		case 'reveal_range':
			return vscode.l10n.t('定位范围');
		case 'create_edit_proposal':
			return vscode.l10n.t('创建编辑提案');
		case 'write_file':
			return vscode.l10n.t('写入文件');
		case 'create_file':
			return vscode.l10n.t('创建文件');
		case 'delete_file':
			return vscode.l10n.t('删除文件');
		case 'replace_in_file':
			return vscode.l10n.t('替换文件内容');
		case 'run_command':
			return vscode.l10n.t('执行命令');
		default:
			return toolName;
	}
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

function normalizeInlineCompletionResponse(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed === '<NO_COMPLETION>') {
		return '';
	}

	const fenceMatch = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
	if (fenceMatch) {
		return fenceMatch[1];
	}

	return value;
}

function postJson<T>(urlString: string, headers: Record<string, string>, body: unknown, token?: vscode.CancellationToken): Promise<IJsonResponse<T>> {
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
		let settled = false;
		let responseStream: http.IncomingMessage | undefined;
		let request: http.ClientRequest;
		let cancellationDisposable: vscode.Disposable | undefined;

		const cleanup = () => {
			cancellationDisposable?.dispose();
			cancellationDisposable = undefined;
		};

		const resolveOnce = (value: IJsonResponse<T>) => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			resolve(value);
		};

		const rejectOnce = (error: Error) => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			reject(error);
		};

		const cancelRequest = () => {
			const error = createRequestCancelledError();
			rejectOnce(error);
			responseStream?.destroy(error);
			request.destroy(error);
		};

		request = transport.request(url, {
			method: 'POST',
			headers: requestHeaders
		}, response => {
			responseStream = response;
			const chunks: Buffer[] = [];
			response.on('data', chunk => {
				if (settled) {
					return;
				}

				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			response.on('error', error => {
				rejectOnce(error instanceof Error ? error : new Error(String(error)));
			});
			response.on('end', () => {
				if (settled) {
					return;
				}

				const text = Buffer.concat(chunks).toString('utf8');
				if (!text) {
					rejectOnce(new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode ?? 0)));
					return;
				}

				try {
					const parsed = JSON.parse(text) as T;
					if ((response.statusCode ?? 500) >= 400) {
						const errorMessage = getResponseErrorMessage(parsed);
						rejectOnce(new Error(errorMessage || vscode.l10n.t('Beam \u8bf7\u6c42\u5931\u8d25\uff0c\u72b6\u6001\u7801\uff1a{0}\u3002', response.statusCode ?? 0)));
						return;
					}

					resolveOnce({
						statusCode: response.statusCode ?? 200,
						body: parsed
					});
				} catch (error) {
					const preview = text.replace(/\s+/g, ' ').slice(0, 180);
					rejectOnce(new Error(vscode.l10n.t('Beam 请求返回了非 JSON 响应，状态码：{0}，内容开头：{1}', response.statusCode ?? 0, preview)));
				}
			});
		});

		cancellationDisposable = token?.onCancellationRequested(() => {
			cancelRequest();
		});
		if (token?.isCancellationRequested) {
			cancelRequest();
			return;
		}

		request.on('error', error => {
			rejectOnce(error instanceof Error ? error : new Error(String(error)));
		});
		request.setTimeout(REQUEST_TIMEOUT_MS, () => {
			const error = new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u8d85\u65f6\uff0c\u5df2\u7b49\u5f85 {0} \u79d2\u3002', Math.floor(REQUEST_TIMEOUT_MS / 1000)));
			rejectOnce(error);
			responseStream?.destroy(error);
			request.destroy(error);
		});
		request.write(payload);
		request.end();
	});
}

function createRequestCancelledError(): Error {
	return new Error(vscode.l10n.t('Beam \u8bf7\u6c42\u5df2\u53d6\u6d88\u3002'));
}

function getResponseErrorMessage(value: unknown): string | undefined {
	const maybeError = (value as { error?: { message?: unknown } }).error;
	return typeof maybeError?.message === 'string' ? maybeError.message : undefined;
}

function normalizeStoredAccessToken(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function shouldRetryBeamRequest(error: Error): boolean {
	return isGatewayRetryableError(error.message)
		|| hasRetryableStatusCode(error.message)
		|| /timeout|timed out|socket hang up|econnreset|econnrefused|enotfound|temporarily unavailable|network error|fetch failed|upstream/i.test(error.message);
}

function isGatewayRetryableError(message: string): boolean {
	return /状态码：\s*(502|503|504)\b/.test(message)
		|| /\b(502|503|504)\b/.test(message) && /gateway|bad gateway|service unavailable|time-?out|non json|html/i.test(message);
}

function hasRetryableStatusCode(message: string): boolean {
	const matches = message.match(/\b(408|409|425|429|500|502|503|504)\b/g) ?? [];
	return matches.length > 0;
}

function toUserFacingBeamErrorMessage(message: string): string {
	if (/已取消/.test(message)) {
		return message;
	}

	if (shouldRetryBeamRequest(new Error(message))) {
		return vscode.l10n.t('Beam 服务暂时不可用，已自动重试多次。请稍后再试。');
	}

	if (/invalid x-api-key|unauthorized|forbidden|状态码：\s*(401|403)\b/i.test(message)) {
		return vscode.l10n.t('访问令牌无效或已失效，请重新输入后再试。');
	}

	if (/状态码：\s*404\b|404 page not found/i.test(message)) {
		return vscode.l10n.t('当前模型服务地址不可用，请检查 Base URL 或模型接口配置。');
	}

	if (/非 JSON 响应|unexpected token\s*</i.test(message)) {
		return vscode.l10n.t('模型服务暂时返回了异常响应，请稍后再试。');
	}

	return message;
}

function sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		const handle = setTimeout(() => {
			disposable?.dispose();
			resolve();
		}, ms);

		const disposable = token?.onCancellationRequested(() => {
			clearTimeout(handle);
			disposable?.dispose();
			reject(createRequestCancelledError());
		});

		if (token?.isCancellationRequested) {
			clearTimeout(handle);
			disposable?.dispose();
			reject(createRequestCancelledError());
		}
	});
}
