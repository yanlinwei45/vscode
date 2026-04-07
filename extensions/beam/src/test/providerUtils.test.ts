/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { buildOpenAIChatCompletionMessages, buildOpenAIInputItems, getBeamFallbackModels, getBeamModelOption, getBeamModelOptions, inferBeamProviderForModel, normalizeBeamModelSelection, normalizeBeamProvider, parseOpenAIFunctionArguments, resolveBeamModel, sortBeamModels, toOpenAIChatCompletionTools, toOpenAITools, type IRequestTurn } from '../providerUtils';

suite('Beam Provider Utils', () => {

	test('normalizes provider names and resolves provider defaults', () => {
		assert.strictEqual(normalizeBeamProvider(undefined), 'anthropic');
		assert.strictEqual(normalizeBeamProvider('openai'), 'openai');
		assert.strictEqual(normalizeBeamProvider(' OpenAI '), 'openai');
		assert.strictEqual(inferBeamProviderForModel('claude-sonnet-4-5'), 'anthropic');
		assert.strictEqual(inferBeamProviderForModel('default'), 'anthropic');
		assert.strictEqual(inferBeamProviderForModel('gpt-5.4'), 'openai');
		assert.strictEqual(inferBeamProviderForModel(undefined, 'openai'), 'openai');
		assert.strictEqual(resolveBeamModel('anthropic', undefined, undefined), 'claude-sonnet-4-5');
		assert.strictEqual(resolveBeamModel('openai', undefined, undefined), 'gpt-5.4');
		assert.strictEqual(resolveBeamModel('openai', 'gpt-5-codex', 'gpt-5.4'), 'gpt-5.3-codex');
		assert.strictEqual(resolveBeamModel('anthropic', 'opus[1m]', undefined), 'claude-opus-4-6-1m');
		assert.strictEqual(normalizeBeamModelSelection('claude-3-5-haiku-latest'), 'claude-haiku-4-5');
	});

	test('adapts beam tools to openai function tools', () => {
		const tools = toOpenAITools([{
			name: 'read_file',
			description: 'Read a file',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string' }
				},
				required: ['path']
			}
		}]);

		assert.deepStrictEqual(tools, [{
			type: 'function',
			name: 'read_file',
			description: 'Read a file',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' }
				},
				required: ['path']
			}
		}]);

		assert.deepStrictEqual(toOpenAIChatCompletionTools([{
			name: 'read_file',
			description: 'Read a file',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string' }
				},
				required: ['path']
			}
		}]), [{
			type: 'function',
			function: {
				name: 'read_file',
				description: 'Read a file',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string' }
					},
					required: ['path']
				}
			}
		}]);
	});

	test('builds openai input items for messages, files and tool turns', () => {
		const turns: IRequestTurn[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'hello' },
					{ type: 'image', mediaType: 'image/png', data: 'AAA=' },
					{ type: 'document', title: 'spec.pdf', mediaType: 'application/pdf', data: 'BBB=' }
				]
			},
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'let me inspect that' },
					{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } }
				]
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', toolUseId: 'call_1', content: 'file contents' }
				]
			}
		];

		const items = buildOpenAIInputItems(turns);
		assert.deepStrictEqual(items, [
			{
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'hello' },
					{ type: 'input_image', image_url: 'data:image/png;base64,AAA=', detail: 'auto' },
					{ type: 'input_file', filename: 'spec.pdf', file_data: 'BBB=' }
				]
			},
			{
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'input_text', text: 'let me inspect that' }
				]
			},
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'read_file',
				arguments: '{"path":"README.md"}'
			},
			{
				type: 'function_call_output',
				call_id: 'call_1',
				output: 'file contents'
			}
		]);
	});

	test('builds openai chat completion messages for tool conversations', () => {
		const turns: IRequestTurn[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'hello' }
				]
			},
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'let me inspect that' },
					{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } }
				]
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', toolUseId: 'call_1', content: 'file contents' }
				]
			}
		];

		assert.deepStrictEqual(buildOpenAIChatCompletionMessages('system prompt', turns), [
			{ role: 'system', content: 'system prompt' },
			{ role: 'user', content: 'hello' },
			{
				role: 'assistant',
				content: 'let me inspect that',
				tool_calls: [{
					id: 'call_1',
					type: 'function',
					function: {
						name: 'read_file',
						arguments: '{"path":"README.md"}'
					}
				}]
			},
			{
				role: 'tool',
				tool_call_id: 'call_1',
				content: 'file contents'
			}
		]);
	});

	test('parses openai function arguments and rejects invalid json', () => {
		assert.deepStrictEqual(parseOpenAIFunctionArguments('{"path":"README.md"}'), { path: 'README.md' });
		assert.deepStrictEqual(parseOpenAIFunctionArguments(undefined), {});
		assert.throws(() => parseOpenAIFunctionArguments('{'), /invalid OpenAI tool arguments/i);
	});

	test('keeps verified beam model defaults visible and prioritizes current frontier models', () => {
		const fallbackModels = getBeamFallbackModels();
		assert.ok(fallbackModels.includes('gpt-5.4'));
		assert.ok(fallbackModels.includes('gpt-5.3-codex'));
		assert.ok(fallbackModels.includes('claude-opus-4-6'));
		assert.ok(fallbackModels.includes('claude-opus-4-6-1m'));
		assert.ok(fallbackModels.includes('claude-sonnet-4-5'));
		assert.ok(fallbackModels.includes('claude-haiku-4-5'));

		const sorted = sortBeamModels([
			'claude-sonnet-4-5',
			'gpt-5.3-codex',
			'zzz-custom-model',
			'gpt-5.4',
			'claude-opus-4-6'
		]);
		assert.deepStrictEqual(sorted.slice(0, 4), [
			'claude-sonnet-4-5',
			'claude-opus-4-6',
			'gpt-5.4',
			'gpt-5.3-codex'
		]);
		assert.strictEqual(sorted[sorted.length - 1], 'zzz-custom-model');
	});

	test('exposes canonical beam model options with request model mappings', () => {
		const options = getBeamModelOptions();
		assert.deepStrictEqual(options.map(option => option.id), [
			'claude-sonnet-4-5',
			'claude-opus-4-6',
			'claude-opus-4-6-1m',
			'claude-haiku-4-5',
			'gpt-5.4',
			'gpt-5.3-codex',
			'gpt-5.2-codex',
			'gpt-5.1-codex-max',
			'gpt-5.2',
			'gpt-5.1-codex-mini'
		]);
		assert.deepStrictEqual(getBeamModelOption('claude-opus-4-6-1m'), {
			id: 'claude-opus-4-6-1m',
			label: 'Opus (1M context)',
			provider: 'anthropic',
			requestModel: 'claude-opus-4-6',
			anthropicBeta: 'context-1m-2025-08-07',
			aliases: ['opus[1m]', 'claude-opus-4-6[1m]']
		});
		assert.strictEqual(getBeamModelOption('claude-sonnet-4-5')?.requestModel, 'claude-sonnet-4-5-20250929');
		assert.strictEqual(getBeamModelOption('claude-haiku-4-5')?.requestModel, 'claude-haiku-4-5-20251001');
		assert.strictEqual(getBeamModelOption('gpt-5-codex')?.id, 'gpt-5.3-codex');
	});
});
