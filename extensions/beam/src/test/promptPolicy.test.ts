/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { buildSystemPrompt, COMPLEX_TASK_POLICY, DEFAULT_SYSTEM_PROMPT, PROPOSAL_ONLY_POLICY } from '../promptPolicy';

suite('Beam Prompt Policy', () => {

	test('appends proposal-only policy to default prompt', () => {
		const prompt = buildSystemPrompt();

		assert.ok(prompt.includes(DEFAULT_SYSTEM_PROMPT));
		assert.ok(prompt.includes(COMPLEX_TASK_POLICY));
		assert.ok(prompt.includes(PROPOSAL_ONLY_POLICY));
		assert.ok(prompt.includes('`run_command` is only for read-only inspection'));
		assert.ok(prompt.includes('Complex-task requirement'));
		assert.ok(prompt.includes('full-file replacement proposal'));
	});

	test('appends proposal-only policy to configured prompt', () => {
		const configuredPrompt = 'Explain risks first, then give recommendations.';
		const prompt = buildSystemPrompt(configuredPrompt);

		assert.ok(prompt.startsWith(configuredPrompt));
		assert.ok(prompt.includes(COMPLEX_TASK_POLICY));
		assert.ok(prompt.includes(PROPOSAL_ONLY_POLICY));
	});
});
