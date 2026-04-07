/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, PROPOSAL_ONLY_POLICY } from '../promptPolicy';

suite('Beam Prompt Policy', () => {

	test('appends proposal-only policy to default prompt', () => {
		const prompt = buildSystemPrompt();

		assert.ok(prompt.includes(DEFAULT_SYSTEM_PROMPT));
		assert.ok(prompt.includes(PROPOSAL_ONLY_POLICY));
		assert.ok(prompt.includes('run_command 只能用于只读检查'));
	});

	test('appends proposal-only policy to configured prompt', () => {
		const configuredPrompt = '请优先解释风险，再给出建议。';
		const prompt = buildSystemPrompt(configuredPrompt);

		assert.ok(prompt.startsWith(configuredPrompt));
		assert.ok(prompt.includes(PROPOSAL_ONLY_POLICY));
	});
});
