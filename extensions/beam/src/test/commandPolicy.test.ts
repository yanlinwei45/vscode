/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { isReadOnlyCommand, isSafeCommand } from '../commandPolicy';

suite('Beam Command Policy', () => {

	test('allows safe read-only shell commands', () => {
		assert.strictEqual(isSafeCommand('rg Beam extensions/beam/src'), true);
		assert.strictEqual(isReadOnlyCommand('rg Beam extensions/beam/src'), true);
		assert.strictEqual(isReadOnlyCommand('git status --short'), true);
		assert.strictEqual(isReadOnlyCommand('git log --oneline'), true);
	});

	test('rejects unsafe shell control operators', () => {
		assert.strictEqual(isSafeCommand('rg Beam | head'), false);
		assert.strictEqual(isSafeCommand('cat foo && rm foo'), false);
		assert.strictEqual(isSafeCommand('ls > out.txt'), false);
	});

	test('rejects write-capable or state-changing commands', () => {
		assert.strictEqual(isReadOnlyCommand('npm run build'), false);
		assert.strictEqual(isReadOnlyCommand('git branch new-feature'), false);
		assert.strictEqual(isReadOnlyCommand('python script.py'), false);
	});
});
