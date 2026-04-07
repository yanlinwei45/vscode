/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { applyProposalTextToContent } from '../proposalText';

suite('Beam Proposal Text', () => {

	test('inserts code at the active offset', () => {
		const text = 'const value = 1;';
		const actual = applyProposalTextToContent(text, 'Beam ', 'insert', 6, []);

		assert.strictEqual(actual, 'const Beam value = 1;');
	});

	test('replaces multiple selections from bottom to top', () => {
		const text = 'alpha beta gamma';
		const actual = applyProposalTextToContent(text, 'Beam', 'replace', 0, [
			{ start: 0, end: 5 },
			{ start: 11, end: 16 },
		]);

		assert.strictEqual(actual, 'Beam beta Beam');
	});

	test('ignores empty selections during replace', () => {
		const text = 'alpha beta';
		const actual = applyProposalTextToContent(text, 'Beam', 'replace', 0, [
			{ start: 0, end: 0 },
			{ start: 6, end: 10 },
		]);

		assert.strictEqual(actual, 'alpha Beam');
	});

	test('replaces the full document when no selection exists', () => {
		const text = 'alpha beta';
		const actual = applyProposalTextToContent(text, 'const next = true;\n', 'replace', 0, []);

		assert.strictEqual(actual, 'const next = true;\n');
	});
});
