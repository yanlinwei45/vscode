/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBeamToolDefinition } from './toolService';

export type BeamProvider = 'anthropic' | 'openai';

export interface IBeamModelOption {
	readonly id: string;
	readonly label: string;
	readonly provider: BeamProvider;
	readonly requestModel: string;
	readonly anthropicBeta?: string;
	readonly aliases?: readonly string[];
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';
const ANTHROPIC_CONTEXT_1M_BETA = 'context-1m-2025-08-07';

// Verified against current official model docs:
// OpenAI all models: https://developers.openai.com/api/docs/models/all
// OpenAI GPT-5.4: https://developers.openai.com/api/docs/models/gpt-5.4
// OpenAI GPT-5.3-Codex: https://developers.openai.com/api/docs/models/gpt-5.3-codex
// Anthropic Claude Code model configuration: https://code.claude.com/docs/en/model-config
// Anthropic 1M context window: https://docs.anthropic.com/en/docs/build-with-claude/context-windows
const BEAM_MODEL_OPTIONS: readonly IBeamModelOption[] = [
	{
		id: 'claude-sonnet-4-5',
		label: 'Default (recommended)',
		provider: 'anthropic',
		requestModel: 'claude-sonnet-4-5-20250929',
		aliases: [
			'default',
			'sonnet',
			'claude-sonnet-4-5',
			'claude-sonnet-4-5-20250929',
			'claude-sonnet-4-20250514',
			'claude-3-7-sonnet-latest',
			'claude-3-7-sonnet-20250219',
			'claude-3-5-sonnet-latest',
			'claude-3-5-sonnet-20241022'
		]
	},
	{
		id: 'claude-opus-4-6',
		label: 'Opus',
		provider: 'anthropic',
		requestModel: 'claude-opus-4-6',
		aliases: [
			'opus',
			'best',
			'claude-opus-4-1-20250805',
			'claude-opus-4-20250514'
		]
	},
	{
		id: 'claude-opus-4-6-1m',
		label: 'Opus (1M context)',
		provider: 'anthropic',
		requestModel: 'claude-opus-4-6',
		anthropicBeta: ANTHROPIC_CONTEXT_1M_BETA,
		aliases: [
			'opus[1m]',
			'claude-opus-4-6[1m]'
		]
	},
	{
		id: 'claude-haiku-4-5',
		label: 'Haiku',
		provider: 'anthropic',
		requestModel: 'claude-haiku-4-5-20251001',
		aliases: [
			'haiku',
			'claude-haiku-4-5',
			'claude-haiku-4-5-20251001',
			'claude-3-5-haiku-latest',
			'claude-3-5-haiku-20241022'
		]
	},
	{
		id: 'gpt-5.4',
		label: 'gpt-5.4',
		provider: 'openai',
		requestModel: 'gpt-5.4',
		aliases: ['gpt-5']
	},
	{
		id: 'gpt-5.3-codex',
		label: 'gpt-5.3-codex',
		provider: 'openai',
		requestModel: 'gpt-5.3-codex',
		aliases: ['gpt-5-codex', 'gpt-5.1-codex']
	},
	{
		id: 'gpt-5.2-codex',
		label: 'gpt-5.2-codex',
		provider: 'openai',
		requestModel: 'gpt-5.2-codex'
	},
	{
		id: 'gpt-5.1-codex-max',
		label: 'gpt-5.1-codex-max',
		provider: 'openai',
		requestModel: 'gpt-5.1-codex-max'
	},
	{
		id: 'gpt-5.2',
		label: 'gpt-5.2',
		provider: 'openai',
		requestModel: 'gpt-5.2',
		aliases: ['gpt-5.1']
	},
	{
		id: 'gpt-5.1-codex-mini',
		label: 'gpt-5.1-codex-mini',
		provider: 'openai',
		requestModel: 'gpt-5.1-codex-mini'
	}
];

const BEAM_MODEL_OPTION_BY_ID = new Map(
	BEAM_MODEL_OPTIONS.map(option => [option.id.toLowerCase(), option] as const)
);

const BEAM_MODEL_ALIAS_TO_ID = new Map<string, string>();
for (const option of BEAM_MODEL_OPTIONS) {
	BEAM_MODEL_ALIAS_TO_ID.set(option.id.toLowerCase(), option.id);
	if (!BEAM_MODEL_ALIAS_TO_ID.has(option.requestModel.toLowerCase())) {
		BEAM_MODEL_ALIAS_TO_ID.set(option.requestModel.toLowerCase(), option.id);
	}

	for (const alias of option.aliases ?? []) {
		BEAM_MODEL_ALIAS_TO_ID.set(alias.toLowerCase(), option.id);
	}
}

const BEAM_MODEL_PRIORITY = new Map(
	BEAM_MODEL_OPTIONS.map((option, index) => [option.id.toLowerCase(), index] as const)
);

export interface IBeamTextContentBlock {
	readonly type: 'text';
	readonly text: string;
}

export interface IBeamImageContentBlock {
	readonly type: 'image';
	readonly mediaType: string;
	readonly data: string;
}

export interface IBeamDocumentContentBlock {
	readonly type: 'document';
	readonly mediaType: string;
	readonly data: string;
	readonly title?: string;
}

export interface IBeamToolUseContentBlock {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input?: unknown;
}

export interface IBeamToolResultContentBlock {
	readonly type: 'tool_result';
	readonly toolUseId: string;
	readonly content: string;
}

export type IBeamTurnContentBlock =
	| IBeamTextContentBlock
	| IBeamImageContentBlock
	| IBeamDocumentContentBlock
	| IBeamToolUseContentBlock
	| IBeamToolResultContentBlock;

export interface IRequestTurn {
	readonly role: 'user' | 'assistant';
	readonly content: readonly IBeamTurnContentBlock[];
}

export interface IOpenAIInputTextContent {
	readonly type: 'input_text';
	readonly text: string;
}

export interface IOpenAIInputImageContent {
	readonly type: 'input_image';
	readonly image_url: string;
	readonly detail?: 'auto' | 'low' | 'high';
}

export interface IOpenAIInputFileContent {
	readonly type: 'input_file';
	readonly filename?: string;
	readonly file_data: string;
}

export interface IOpenAIMessageInputItem {
	readonly type: 'message';
	readonly role: 'user' | 'assistant' | 'system' | 'developer';
	readonly content: readonly (IOpenAIInputTextContent | IOpenAIInputImageContent | IOpenAIInputFileContent)[];
}

export interface IOpenAIFunctionCallInputItem {
	readonly type: 'function_call';
	readonly call_id: string;
	readonly name: string;
	readonly arguments: string;
}

export interface IOpenAIFunctionCallOutputInputItem {
	readonly type: 'function_call_output';
	readonly call_id: string;
	readonly output: string;
}

export type IOpenAIInputItem =
	| IOpenAIMessageInputItem
	| IOpenAIFunctionCallInputItem
	| IOpenAIFunctionCallOutputInputItem
	| Record<string, unknown>;

export interface IOpenAIFunctionToolDefinition {
	readonly type: 'function';
	readonly name: string;
	readonly description: string;
	readonly parameters: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface IOpenAIChatCompletionToolDefinition {
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

export function normalizeBeamProvider(value: string | undefined): BeamProvider {
	return value?.trim().toLowerCase() === 'openai' ? 'openai' : 'anthropic';
}

export function inferBeamProviderForModel(modelId: string | undefined, fallbackProvider: BeamProvider = 'anthropic'): BeamProvider {
	const normalizedSelection = normalizeBeamModelSelection(modelId);
	if (normalizedSelection) {
		return getBeamModelOption(normalizedSelection)?.provider ?? fallbackProvider;
	}

	const normalized = modelId?.trim().toLowerCase();
	if (!normalized) {
		return fallbackProvider;
	}

	if (normalized.startsWith('claude-') || normalized === 'default' || normalized === 'sonnet' || normalized.startsWith('opus') || normalized === 'haiku') {
		return 'anthropic';
	}

	return 'openai';
}

export function resolveBeamModel(provider: BeamProvider, explicitlyConfiguredModel: string | undefined, envModel: string | undefined): string {
	const explicit = normalizeBeamModelSelection(explicitlyConfiguredModel);
	if (explicit && getBeamModelOption(explicit)?.provider === provider) {
		return explicit;
	}

	const environmentModel = normalizeBeamModelSelection(envModel);
	if (environmentModel && getBeamModelOption(environmentModel)?.provider === provider) {
		return environmentModel;
	}

	return provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL;
}

export function getBeamFallbackModels(): readonly string[] {
	return BEAM_MODEL_OPTIONS.map(option => option.id);
}

export function getBeamModelOptions(): readonly IBeamModelOption[] {
	return [...BEAM_MODEL_OPTIONS];
}

export function getBeamModelOption(modelId: string | undefined): IBeamModelOption | undefined {
	const normalized = normalizeBeamModelSelection(modelId);
	return normalized ? BEAM_MODEL_OPTION_BY_ID.get(normalized.toLowerCase()) : undefined;
}

export function normalizeBeamModelSelection(modelId: string | undefined): string | undefined {
	const trimmed = modelId?.trim();
	if (!trimmed) {
		return undefined;
	}

	return BEAM_MODEL_ALIAS_TO_ID.get(trimmed.toLowerCase());
}

export function sortBeamModels(models: readonly string[]): string[] {
	const uniqueModels = [...new Set(
		models
			.map(model => model.trim())
			.filter(Boolean)
	)];

	return uniqueModels.sort((left, right) => {
		const leftPriority = BEAM_MODEL_PRIORITY.get(left.toLowerCase());
		const rightPriority = BEAM_MODEL_PRIORITY.get(right.toLowerCase());
		if (leftPriority !== undefined || rightPriority !== undefined) {
			if (leftPriority === undefined) {
				return 1;
			}

			if (rightPriority === undefined) {
			return -1;
		}

		if (leftPriority !== rightPriority) {
			return leftPriority - rightPriority;
			}
		}

		const leftProvider = inferBeamProviderForModel(left);
		const rightProvider = inferBeamProviderForModel(right);
		if (leftProvider !== rightProvider) {
			return leftProvider === 'anthropic' ? -1 : 1;
		}

		return left.localeCompare(right, undefined, { sensitivity: 'base' });
	});
}

export function toOpenAITools(definitions: readonly IBeamToolDefinition[]): readonly IOpenAIFunctionToolDefinition[] {
	return definitions.map(definition => ({
		type: 'function',
		name: definition.name,
		description: definition.description,
		parameters: {
			type: 'object',
			properties: definition.input_schema.properties,
			required: definition.input_schema.required
		}
	}));
}

export function toOpenAIChatCompletionTools(definitions: readonly IBeamToolDefinition[]): readonly IOpenAIChatCompletionToolDefinition[] {
	return definitions.map(definition => ({
		type: 'function',
		function: {
			name: definition.name,
			description: definition.description,
			parameters: {
				type: 'object',
				properties: definition.input_schema.properties,
				required: definition.input_schema.required
			}
		}
	}));
}

export function buildOpenAIInputItems(turns: readonly IRequestTurn[]): IOpenAIInputItem[] {
	const items: IOpenAIInputItem[] = [];

	for (const turn of turns) {
		let messageContent: (IOpenAIInputTextContent | IOpenAIInputImageContent | IOpenAIInputFileContent)[] = [];

		const flushMessageContent = () => {
			if (!messageContent.length) {
				return;
			}

			items.push({
				type: 'message',
				role: turn.role,
				content: messageContent
			});
			messageContent = [];
		};

		for (const block of turn.content) {
			switch (block.type) {
				case 'text':
					messageContent.push({
						type: 'input_text',
						text: block.text
					});
					break;
				case 'image':
					messageContent.push({
						type: 'input_image',
						image_url: `data:${block.mediaType};base64,${block.data}`,
						detail: 'auto'
					});
					break;
				case 'document':
					messageContent.push({
						type: 'input_file',
						filename: block.title,
						file_data: block.data
					});
					break;
				case 'tool_use':
					flushMessageContent();
					items.push({
						type: 'function_call',
						call_id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.input ?? {})
					});
					break;
				case 'tool_result':
					flushMessageContent();
					items.push({
						type: 'function_call_output',
						call_id: block.toolUseId,
						output: block.content
					});
					break;
			}
		}

		flushMessageContent();
	}

	return items;
}

export function buildOpenAIChatCompletionMessages(systemPrompt: string, turns: readonly IRequestTurn[]): Array<{
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content?: string;
	readonly tool_calls?: Array<{
		readonly id: string;
		readonly type: 'function';
		readonly function: {
			readonly name: string;
			readonly arguments: string;
		};
	}>;
	readonly tool_call_id?: string;
}> {
	const messages: Array<{
		readonly role: 'system' | 'user' | 'assistant' | 'tool';
		readonly content?: string;
		readonly tool_calls?: Array<{
			readonly id: string;
			readonly type: 'function';
			readonly function: {
				readonly name: string;
				readonly arguments: string;
			};
		}>;
		readonly tool_call_id?: string;
	}> = [{ role: 'system', content: systemPrompt }];

	for (const turn of turns) {
		if (turn.role === 'assistant') {
			const content = turn.content
				.filter((block): block is Extract<IBeamTurnContentBlock, { readonly type: 'text' }> => block.type === 'text')
				.map(block => block.text)
				.join('\n')
				.trim();
			const toolCalls = turn.content
				.filter((block): block is Extract<IBeamTurnContentBlock, { readonly type: 'tool_use' }> => block.type === 'tool_use')
				.map(block => ({
					id: block.id,
					type: 'function' as const,
					function: {
						name: block.name,
						arguments: JSON.stringify(block.input ?? {})
					}
				}));
			if (content || toolCalls.length) {
				messages.push({
					role: 'assistant',
					content: content || undefined,
					tool_calls: toolCalls.length ? toolCalls : undefined
				});
			}
			continue;
		}

		const text = turn.content
			.filter((block): block is Extract<IBeamTurnContentBlock, { readonly type: 'text' }> => block.type === 'text')
			.map(block => block.text)
			.join('\n')
			.trim();
		if (text) {
			messages.push({
				role: 'user',
				content: text
			});
		}

		for (const toolResult of turn.content.filter((block): block is Extract<IBeamTurnContentBlock, { readonly type: 'tool_result' }> => block.type === 'tool_result')) {
			messages.push({
				role: 'tool',
				tool_call_id: toolResult.toolUseId,
				content: toolResult.content
			});
		}
	}

	return messages;
}

export function parseOpenAIFunctionArguments(rawArguments: string | undefined): unknown {
	const source = rawArguments?.trim();
	if (!source) {
		return {};
	}

	try {
		return JSON.parse(source);
	} catch (error) {
		throw new Error(`Beam received invalid OpenAI tool arguments: ${error instanceof Error ? error.message : String(error)}`);
	}
}
