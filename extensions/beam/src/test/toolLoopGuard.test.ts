/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { BeamToolLoopGuard } from '../toolLoopGuard';

suite('Beam Tool Loop Guard', () => {

	test('stops repeated identical investigation rounds', () => {
		const guard = new BeamToolLoopGuard();
		const toolUses = [
			{ name: 'search_workspace', input: { query: 'beamService' } },
			{ name: 'read_file', input: { path: 'extensions/beam/src/beamService.ts' } }
		];

		assert.deepStrictEqual(guard.register(toolUses), { shouldStop: false });
		assert.deepStrictEqual(guard.register(toolUses), { shouldStop: false });

		const decision = guard.register(toolUses);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /repeating the same investigation tool sequence/i);
	});

	test('stops when the same investigation input appears too many times across rounds', () => {
		const guard = new BeamToolLoopGuard();

		assert.strictEqual(guard.register([{ name: 'search_workspace', input: { query: 'foo' } }]).shouldStop, false);
		assert.strictEqual(guard.register([{ name: 'read_file', input: { path: 'a.ts' } }]).shouldStop, false);

		const decision = guard.register([{ name: 'search_workspace', input: { query: 'foo' } }]);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /same tool input/i);
	});

	test('does not stop when the workflow moves from investigation into editing', () => {
		const guard = new BeamToolLoopGuard();

		assert.strictEqual(guard.register([{ name: 'search_workspace', input: { query: 'foo' } }]).shouldStop, false);
		assert.strictEqual(guard.register([{ name: 'read_file', input: { path: 'a.ts' } }]).shouldStop, false);

		const decision = guard.register([{ name: 'create_edit_proposal', input: { code: 'const x = 1;', mode: 'replace' } }]);
		assert.strictEqual(decision.shouldStop, false);
	});

	test('stops heavy investigation rounds even when signatures vary', () => {
		const guard = new BeamToolLoopGuard();

		assert.strictEqual(guard.register([
			{ name: 'list_directory', input: { path: 'src' } },
			{ name: 'read_file', input: { path: 'src/a.ts' } },
			{ name: 'read_file', input: { path: 'src/b.ts' } }
		]).shouldStop, false);
		assert.strictEqual(guard.register([
			{ name: 'list_directory', input: { path: 'src/components' } },
			{ name: 'read_file', input: { path: 'src/components/a.tsx' } },
			{ name: 'read_file', input: { path: 'src/components/b.tsx' } }
		]).shouldStop, false);
		assert.strictEqual(guard.register([
			{ name: 'read_file', input: { path: 'src/c.ts' } },
			{ name: 'list_directory', input: { path: 'src/utils' } },
			{ name: 'read_file', input: { path: 'src/utils/a.ts' } }
		]).shouldStop, false);

		const decision = guard.register([
			{ name: 'list_directory', input: { path: 'src/hooks' } },
			{ name: 'read_file', input: { path: 'src/hooks/a.ts' } },
			{ name: 'read_file', input: { path: 'src/hooks/b.ts' } }
		]);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /too many rounds only reading files and searching/i);
	});

	test('stops directory-heavy investigation loops', () => {
		const guard = new BeamToolLoopGuard();

		assert.strictEqual(guard.register([
			{ name: 'list_directory', input: { path: 'src' } },
			{ name: 'list_directory', input: { path: 'src/features' } },
			{ name: 'read_file', input: { path: 'src/index.ts' } }
		]).shouldStop, false);
		assert.strictEqual(guard.register([
			{ name: 'list_directory', input: { path: 'src/views' } },
			{ name: 'list_directory', input: { path: 'src/views/home' } },
			{ name: 'read_file', input: { path: 'src/views/home/index.tsx' } }
		]).shouldStop, false);

		const decision = guard.register([
			{ name: 'list_directory', input: { path: 'src/panels' } },
			{ name: 'list_directory', input: { path: 'src/panels/beam' } },
			{ name: 'read_file', input: { path: 'src/panels/beam/index.tsx' } }
		]);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /expanding directories/i);
	});

	test('stops command-heavy investigation loops', () => {
		const guard = new BeamToolLoopGuard();

		assert.strictEqual(guard.register([
			{ name: 'run_command', input: { command: 'git status --short' } },
			{ name: 'search_workspace', input: { query: 'Beam' } },
			{ name: 'get_diagnostics', input: {} }
		]).shouldStop, false);
		assert.strictEqual(guard.register([
			{ name: 'run_command', input: { command: 'git diff --stat' } },
			{ name: 'read_file', input: { path: 'src/app.ts' } },
			{ name: 'get_diagnostics', input: {} }
		]).shouldStop, false);

		const decision = guard.register([
			{ name: 'run_command', input: { command: 'git status --short' } },
			{ name: 'search_workspace', input: { query: 'BeamService' } },
			{ name: 'get_diagnostics', input: {} }
		]);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /running read-only commands/i);
	});

	test('stops simple-query investigation earlier', () => {
		const guard = new BeamToolLoopGuard({ simpleQuery: true });

		assert.strictEqual(guard.register([
			{ name: 'read_file', input: { path: 'src/a.ts' } },
			{ name: 'search_workspace', input: { query: 'foo' } },
			{ name: 'get_diagnostics', input: {} }
		]).shouldStop, false);

		const decision = guard.register([
			{ name: 'read_file', input: { path: 'src/b.ts' } },
			{ name: 'search_workspace', input: { query: 'bar' } },
			{ name: 'get_diagnostics', input: {} }
		]);
		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /too many rounds only reading files and searching/i);
	});

	test('stops when too many investigation tools are requested in a single round', () => {
		const guard = new BeamToolLoopGuard();

		const decision = guard.register([
			{ name: 'read_file', input: { path: 'src/a.ts' } },
			{ name: 'read_file', input: { path: 'src/b.ts' } },
			{ name: 'read_file', input: { path: 'src/c.ts' } },
			{ name: 'read_file', input: { path: 'src/d.ts' } },
			{ name: 'search_workspace', input: { query: 'foo' } },
			{ name: 'search_workspace', input: { query: 'bar' } },
			{ name: 'get_diagnostics', input: {} },
			{ name: 'run_command', input: { command: 'git status --short' } },
			{ name: 'list_directory', input: { path: 'src' } }
		]);

		assert.strictEqual(decision.shouldStop, true);
		assert.match(decision.reason || '', /too many investigation actions in a single round/i);
	});
});
