/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { buildModelFacingUserPrompt, buildStructuredContinuationSections, deriveSessionTaskState, getCurrentTaskMessageWindow, isContinuationOnlyPrompt, normalizeSessionTaskState, toTaskStateSections, type IBeamSessionTaskMessage } from '../sessionTaskState';

suite('Beam Session Task State', () => {

	test('recognizes continuation-only prompts across chinese and english variants', () => {
		assert.strictEqual(isContinuationOnlyPrompt('继续'), true);
		assert.strictEqual(isContinuationOnlyPrompt('继续！！！'), true);
		assert.strictEqual(isContinuationOnlyPrompt('continue'), true);
		assert.strictEqual(isContinuationOnlyPrompt('Keep going'), true);
		assert.strictEqual(isContinuationOnlyPrompt('继续修复登录页样式'), false);
		assert.strictEqual(isContinuationOnlyPrompt('please continue and also add tests'), false);
	});

	test('keeps current task window anchored to latest explicit objective', () => {
		const messages: IBeamSessionTaskMessage[] = [
			{ role: 'user', content: '修复 Beam 的停止按钮' },
			{ role: 'assistant', content: '我先检查取消链路。' },
			{ role: 'user', content: '继续' },
			{ role: 'assistant', content: '我会继续沿着取消链路修复。' },
			{ role: 'user', content: '再优化聊天历史展示' },
			{ role: 'assistant', content: '开始看 sidebar。' }
		];

		assert.deepStrictEqual(getCurrentTaskMessageWindow(messages), messages.slice(4));
	});

	test('derives task state from latest explicit objective and recent tool files', () => {
		const messages: IBeamSessionTaskMessage[] = [
			{ role: 'user', content: '优化 Beam 的多轮对话承接' },
			{ role: 'thinking', content: '我先梳理当前 session memory 和 sidebar 展示。' },
			{
				role: 'tool',
				content: '摘要：已读取 1 个文件\n-- extensions/beam/src/beamService.ts',
				modelContent: 'Summary: Read 1 file\n-- extensions/beam/src/beamService.ts',
				metadata: { toolName: 'read_file' }
			},
			{
				role: 'tool',
				content: '摘要：已修改 1 个文件\n-- extensions/beam/src/sidebarProvider.ts  +12  -3  >\n变更文件：extensions/beam/src/sidebarProvider.ts',
				modelContent: 'Summary: Modified 1 file\n-- extensions/beam/src/sidebarProvider.ts  +12  -3  >\nChanged file: extensions/beam/src/sidebarProvider.ts\nStatus: Editor content has been modified as a pending proposal. The user can accept or reject it in Beam.',
				metadata: { toolName: 'create_edit_proposal' }
			},
			{ role: 'assistant', content: '我已经把任务状态卡片接进侧边栏，下一步会继续收紧 continuation memory。' },
			{ role: 'user', content: '继续' }
		];

		const state = deriveSessionTaskState(messages);
		assert.ok(state);
		assert.strictEqual(state?.objective, '优化 Beam 的多轮对话承接');
		assert.deepStrictEqual(state?.relatedFiles, [
			'extensions/beam/src/beamService.ts',
			'extensions/beam/src/sidebarProvider.ts'
		]);
		assert.ok((state?.completed.length || 0) > 0);
	});

	test('builds model-facing follow-up prompt with objective and working files', () => {
		const prompt = buildModelFacingUserPrompt('继续', {
			objective: '优化 Beam 的多轮对话承接',
			relatedFiles: ['extensions/beam/src/beamService.ts', 'extensions/beam/src/sidebarProvider.ts'],
			completed: [],
			pending: [],
			nextStep: '继续收紧 continuation memory'
		}, true);

		assert.ok(prompt.includes('This is a follow-up turn.'));
		assert.ok(prompt.includes('Primary objective: 优化 Beam 的多轮对话承接'));
		assert.ok(prompt.includes('Recent working files: extensions/beam/src/beamService.ts, extensions/beam/src/sidebarProvider.ts'));
		assert.ok(prompt.includes('Preferred next step: 继续收紧 continuation memory'));
		assert.ok(prompt.includes('Additional attachments are included with this follow-up turn.'));
	});

	test('normalizes restored task state from older cached sessions', () => {
		const normalized = normalizeSessionTaskState({
			objective: '继续优化',
			relatedFiles: undefined as unknown as string[],
			completed: ['已读取 beamService.ts', '', '  '],
			pending: undefined as unknown as string[],
			nextStep: '继续修复'
		});

		assert.deepStrictEqual(normalized, {
			objective: '继续优化',
			relatedFiles: [],
			completed: ['已读取 beamService.ts'],
			pending: [],
			nextStep: '继续修复'
		});
	});

	test('builds continuation sections and task state sections for session memory', () => {
		const messages: IBeamSessionTaskMessage[] = [
			{ role: 'user', content: '优化 Beam 的多轮对话承接' },
			{ role: 'thinking', content: '我先查看 session memory 的组织方式。' },
			{
				role: 'tool',
				content: '摘要：已读取 1 个文件\n-- extensions/beam/src/beamService.ts',
				modelContent: 'Summary: Read 1 file\n-- extensions/beam/src/beamService.ts',
				metadata: { toolName: 'read_file' }
			},
			{ role: 'assistant', content: '下一步我会把 task state 抽到独立 helper。' }
		];

		const sections = buildStructuredContinuationSections(messages);
		assert.ok(sections.includes('Current objective:'));
		assert.ok(sections.includes('- 优化 Beam 的多轮对话承接'));
		assert.ok(sections.includes('Recent tool actions and results:'));

		const taskSections = toTaskStateSections({
			objective: '优化 Beam 的多轮对话承接',
			relatedFiles: ['extensions/beam/src/beamService.ts'],
			completed: ['已读取 beamService.ts'],
			pending: ['抽离 task state helper'],
			nextStep: '补测试'
		});
		assert.deepStrictEqual(taskSections, [
			'Current objective:',
			'- 优化 Beam 的多轮对话承接',
			'Current working files:',
			'- extensions/beam/src/beamService.ts',
			'Completed work:',
			'- 已读取 beamService.ts',
			'Pending work or open threads:',
			'- 抽离 task state helper',
			'Recommended next step:',
			'- 补测试'
		]);
	});
});
