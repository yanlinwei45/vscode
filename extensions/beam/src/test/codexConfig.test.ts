/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { parseCodexAuthConfiguration, parseCodexTomlConfiguration } from '../codexConfig';

suite('Beam Codex Config', () => {

	test('parses codex model, base url and model migrations', () => {
		const parsed = parseCodexTomlConfiguration(`
model_provider = "codex"
model = "gpt-5.4" # comment

[model_providers.codex]
name = "codex"
base_url = "https://code.api.audiozen.cn/v1"
wire_api = "responses"

[notice.model_migrations]
gpt-5-codex = "gpt-5.3-codex"
`);

		assert.deepStrictEqual({
			model: parsed.model,
			baseUrl: parsed.baseUrl,
			modelMigrations: Object.fromEntries(parsed.modelMigrations)
		}, {
			model: 'gpt-5.4',
			baseUrl: 'https://code.api.audiozen.cn/v1',
			modelMigrations: {
				'gpt-5-codex': 'gpt-5.3-codex'
			}
		});
	});

	test('parses openai api key from codex auth json', () => {
		assert.deepStrictEqual(parseCodexAuthConfiguration(`{"OPENAI_API_KEY":"test-key"}`), { apiKey: 'test-key' });
		assert.deepStrictEqual(parseCodexAuthConfiguration('{'), {});
	});
});
