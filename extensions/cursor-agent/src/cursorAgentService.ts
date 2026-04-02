/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';

const STORAGE_KEY = 'cursorAgent.chatState.v1';
const REQUEST_HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 120000;

export interface ICursorChatMessage {
	readonly role: 'user' | 'assistant' | 'system';
	readonly content: string;
}

export interface ICursorChatState {
	readonly messages: readonly ICursorChatMessage[];
	readonly busy: boolean;
	readonly lastRequestContext?: string;
}

interface IAnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: readonly {
		readonly type: 'text';
		readonly text: string;
	}[];
}

interface IAnthropicRequest {
	readonly model: string;
	readonly system?: string;
	readonly max_tokens: number;
	readonly messages: readonly IAnthropicMessage[];
}

interface IAnthropicResponse {
	readonly content?: readonly {
		readonly type?: string;
		readonly text?: string;
	}[];
	readonly choices?: readonly {
		readonly message?: {
			readonly content?: string | readonly { readonly text?: string; readonly type?: string }[];
		};
	}[];
	error?: {
		readonly message?: string;
	};
}

interface IJsonResponse<T> {
	readonly statusCode: number;
	readonly body: T;
}

export class CursorAgentService extends vscode.Disposable {

	private readonly _onDidChangeState = new vscode.EventEmitter<ICursorChatState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private messages: ICursorChatMessage[] = [];
	private busy = false;
	private lastRequestContext: string | undefined;

	constructor(
		private readonly storage: vscode.Memento,
		private readonly outputChannel: vscode.OutputChannel
	) {
		super(() => {
			this._onDidChangeState.dispose();
		});

		this.messages = this.restoreMessages();
		this.log(vscode.l10n.t('Cursor Agent restored {0} message(s).', this.messages.length));
	}

	getState(): ICursorChatState {
		return {
			messages: this.messages,
			busy: this.busy,
			lastRequestContext: this.lastRequestContext
		};
	}

	reset(): void {
		this.messages = [];
		this.busy = false;
		this.lastRequestContext = undefined;
		this.persistState();
		this.log(vscode.l10n.t('Cursor Agent conversation reset.'));
		this._onDidChangeState.fire(this.getState());
	}

	async sendUserMessage(prompt: string, requestContext?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed || this.busy) {
			return;
		}

		this.lastRequestContext = requestContext?.trim() || undefined;
		this.messages = [...this.messages, { role: 'user', content: trimmed }];
		this.busy = true;
		this.persistState();
		this._onDidChangeState.fire(this.getState());

		try {
			const content = await this.requestAssistantResponse();
			this.messages = [...this.messages, { role: 'assistant', content }];
			this.persistState();
		} catch (error) {
			const message = error instanceof Error ? error.message : vscode.l10n.t('Cursor Agent request failed.');
			this.log(vscode.l10n.t('Cursor Agent request failed: {0}', message));
			this.messages = [...this.messages, { role: 'assistant', content: `Error: ${message}` }];
			this.persistState();
		} finally {
			this.busy = false;
			this._onDidChangeState.fire(this.getState());
		}
	}

	showOutput(preserveFocus?: boolean): void {
		this.outputChannel.show(preserveFocus);
	}

	private async requestAssistantResponse(): Promise<string> {
		const { baseUrl, apiKey, authToken, model, systemPrompt } = this.getConfiguration();
		if (!apiKey && !authToken) {
			throw new Error(vscode.l10n.t('Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN before using Cursor Agent.'));
		}

		const body: IAnthropicRequest = {
			model,
			system: systemPrompt,
			max_tokens: 8192,
			messages: this.buildRequestMessages()
		};

		const endpoint = this.resolveEndpoint(baseUrl);
		this.log(vscode.l10n.t('Sending request to {0} with model {1}.', endpoint, model));
		const response = await postJson<IAnthropicResponse>(endpoint, {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
			'x-api-key': apiKey ?? '',
			'authorization': authToken ? `Bearer ${authToken}` : ''
		}, body);
		this.log(vscode.l10n.t('Cursor Agent response received with status {0}.', response.statusCode));

		const text = extractResponseText(response.body).trim();
		if (!text) {
			throw new Error(response.body.error?.message || vscode.l10n.t('Cursor Agent returned an empty response.'));
		}

		return text;
	}

	private getConfiguration(): {
		readonly baseUrl: string;
		readonly apiKey?: string;
		readonly authToken?: string;
		readonly model: string;
		readonly systemPrompt: string;
	} {
		const configuration = vscode.workspace.getConfiguration('cursorAgent');
		const configuredBaseUrl = configuration.get<string>('baseUrl')?.trim();
		const model = configuration.get<string>('model')?.trim() || 'claude-sonnet-4-20250514';
		const systemPrompt = configuration.get<string>('systemPrompt')?.trim() || vscode.l10n.t('You are Cursor, an expert coding assistant inside VS Code. Be concise, practical, and code-focused.');

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

	private restoreMessages(): ICursorChatMessage[] {
		const stored = this.storage.get<ICursorChatMessage[]>(STORAGE_KEY);
		if (!Array.isArray(stored)) {
			return [];
		}

		return stored.filter(isCursorChatMessage);
	}

	private persistState(): void {
		const value = this.messages.slice(-200);
		void this.storage.update(STORAGE_KEY, value);
	}

	private buildRequestMessages(): readonly IAnthropicMessage[] {
		return this.messages
			.filter(message => message.role !== 'system')
			.slice(-REQUEST_HISTORY_LIMIT)
			.map<IAnthropicMessage>((message, index, array) => {
				if (message.role === 'user' && index === array.length - 1 && this.lastRequestContext) {
					return {
						role: 'user',
						content: [{
							type: 'text',
							text: `${message.content}\n\nAttached context:\n${this.lastRequestContext}`
						}]
					};
				}

				return {
					role: message.role === 'assistant' ? 'assistant' : 'user',
					content: [{ type: 'text', text: message.content }]
				};
			});
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}
}

function extractResponseText(response: IAnthropicResponse): string {
	const anthropicText = response.content
		?.filter(part => part.type === 'text' && typeof part.text === 'string')
		.map(part => part.text ?? '')
		.join('');
	if (anthropicText) {
		return anthropicText;
	}

	const openAIText = response.choices
		?.flatMap(choice => {
			const content = choice.message?.content;
			if (typeof content === 'string') {
				return [content];
			}

			if (Array.isArray(content)) {
				return content
					.filter(part => part.type === 'text' && typeof part.text === 'string')
					.map(part => part.text ?? '');
			}

			return [];
		})
		.join('');

	return openAIText || '';
}

function isCursorChatMessage(value: ICursorChatMessage | undefined): value is ICursorChatMessage {
	return Boolean(
		value &&
		(value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
		typeof value.content === 'string'
	);
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
					reject(new Error(vscode.l10n.t('Cursor Agent request failed with status {0}.', response.statusCode ?? 0)));
					return;
				}

				try {
					const parsed = JSON.parse(text) as T;
					if ((response.statusCode ?? 500) >= 400) {
						const errorMessage = (parsed as IAnthropicResponse).error?.message;
						reject(new Error(errorMessage || vscode.l10n.t('Cursor Agent request failed with status {0}.', response.statusCode ?? 0)));
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
			request.destroy(new Error(vscode.l10n.t('Cursor Agent request timed out after {0} seconds.', Math.floor(REQUEST_TIMEOUT_MS / 1000))));
		});
		request.write(payload);
		request.end();
	});
}
