/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IBeamSessionTaskState {
	readonly objective?: string;
	readonly relatedFiles: readonly string[];
	readonly completed: readonly string[];
	readonly pending: readonly string[];
	readonly nextStep?: string;
}

export interface IBeamSessionTaskMessage {
	readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking';
	readonly content: string;
	readonly modelContent?: string;
	readonly metadata?: {
		readonly toolName?: string;
	};
}

interface IUserRequestSummary {
	readonly text: string;
	readonly isFollowUp: boolean;
}

export function deriveSessionTaskState(messages: readonly IBeamSessionTaskMessage[], previousState?: IBeamSessionTaskState): IBeamSessionTaskState | undefined {
	const relevantMessages = getCurrentTaskMessageWindow(messages.slice(-48));
	const userRequests = relevantMessages
		.filter(message => message.role === 'user')
		.map(message => summarizeUserRequest(message))
		.filter((value): value is IUserRequestSummary => Boolean(value));
	const thinkingItems = relevantMessages
		.filter(message => message.role === 'thinking')
		.map(message => compactContinuationContent(message))
		.filter(Boolean);
	const assistantReplies = relevantMessages
		.filter(message => message.role === 'assistant')
		.map(message => compactContinuationContent(message))
		.filter(Boolean);
	const toolItems = relevantMessages
		.filter(message => message.role === 'tool')
		.map(message => {
			const content = compactContinuationContent(message);
			if (!content) {
				return undefined;
			}

			return `${message.metadata?.toolName || 'unknown_tool'}: ${content}`;
		})
		.filter((value): value is string => Boolean(value));

	const objectiveCandidates = userRequests.filter(item => !item.isFollowUp).map(item => item.text);
	const objective = objectiveCandidates[objectiveCandidates.length - 1] || previousState?.objective;
	const completed = summarizeCompletedWork(toolItems, assistantReplies);
	const pending = summarizePendingWork(thinkingItems, assistantReplies);
	const nextStep = summarizeNextStep(thinkingItems, toolItems, assistantReplies);

	if (!objective && !completed.length && !pending.length && !nextStep) {
		return undefined;
	}

	return {
		objective,
		relatedFiles: summarizeRelatedFiles(relevantMessages),
		completed,
		pending,
		nextStep
	};
}

export function buildModelFacingUserPrompt(prompt: string, taskState: IBeamSessionTaskState | undefined, hasAttachmentPayload: boolean): string {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return 'Please continue using the attached context.';
	}

	if (!isContinuationOnlyPrompt(trimmed)) {
		return trimmed;
	}

	const objective = taskState?.objective?.trim();
	const nextStep = taskState?.nextStep?.trim();
	const relatedFiles = taskState?.relatedFiles.filter(Boolean).slice(0, 6) ?? [];
	const lines = ['This is a follow-up turn. Continue the existing task from the current session state instead of restarting.'];
	if (objective) {
		lines.push(`Primary objective: ${objective}`);
	}
	if (relatedFiles.length) {
		lines.push(`Recent working files: ${relatedFiles.join(', ')}`);
	}
	if (nextStep) {
		lines.push(`Preferred next step: ${nextStep}`);
	}
	if (hasAttachmentPayload) {
		lines.push('Additional attachments are included with this follow-up turn.');
	}
	lines.push(`Latest user follow-up: ${trimmed}`);
	return lines.join('\n');
}

export function normalizeSessionTaskState(taskState: IBeamSessionTaskState | undefined): IBeamSessionTaskState | undefined {
	if (!taskState) {
		return undefined;
	}

	return {
		objective: typeof taskState.objective === 'string' ? taskState.objective : undefined,
		relatedFiles: Array.isArray(taskState.relatedFiles) ? taskState.relatedFiles.filter(isNonEmptyString) : [],
		completed: Array.isArray(taskState.completed) ? taskState.completed.filter(isNonEmptyString) : [],
		pending: Array.isArray(taskState.pending) ? taskState.pending.filter(isNonEmptyString) : [],
		nextStep: typeof taskState.nextStep === 'string' ? taskState.nextStep : undefined
	};
}

export function buildStructuredContinuationSections(messages: readonly IBeamSessionTaskMessage[]): string[] {
	const taskMessages = getCurrentTaskMessageWindow(messages);
	const userRequests = taskMessages
		.filter(message => message.role === 'user')
		.map(message => summarizeUserRequest(message))
		.filter((value): value is IUserRequestSummary => Boolean(value))
		.slice(-3);
	const thinkingItems = taskMessages
		.filter(message => message.role === 'thinking')
		.map(message => compactContinuationContent(message))
		.filter(Boolean)
		.slice(-4);
	const assistantReplies = taskMessages
		.filter(message => message.role === 'assistant')
		.map(message => compactContinuationContent(message))
		.filter(Boolean)
		.slice(-3);
	const toolItems = taskMessages
		.filter(message => message.role === 'tool')
		.map(message => {
			const content = compactContinuationContent(message);
			if (!content) {
				return undefined;
			}

			return `${message.metadata?.toolName || 'unknown_tool'}: ${content}`;
		})
		.filter((value): value is string => Boolean(value))
		.slice(-8);

	const sections: string[] = [];
	const userGoalItems = userRequests.filter(item => !item.isFollowUp).map(item => item.text);
	const currentObjective = [...userRequests].reverse().find(item => !item.isFollowUp)?.text;
	const completedWork = summarizeCompletedWork(toolItems, assistantReplies);
	const pendingWork = summarizePendingWork(thinkingItems, assistantReplies);
	const nextStep = summarizeNextStep(thinkingItems, toolItems, assistantReplies);

	if (currentObjective) {
		sections.push('Current objective:');
		sections.push(`- ${currentObjective}`);
	}

	if (completedWork.length) {
		sections.push('Completed work:');
		sections.push(...completedWork.map(item => `- ${item}`));
	}

	if (pendingWork.length) {
		sections.push('Pending work or open threads:');
		sections.push(...pendingWork.map(item => `- ${item}`));
	}

	if (nextStep) {
		sections.push('Recommended next step:');
		sections.push(`- ${nextStep}`);
	}

	if (userGoalItems.length) {
		sections.push('Recent user goals:');
		sections.push(...userGoalItems.map(item => `- ${item}`));
	}

	if (thinkingItems.length) {
		sections.push('Recent analysis:');
		sections.push(...thinkingItems.map(item => `- ${item}`));
	}

	if (toolItems.length) {
		sections.push('Recent tool actions and results:');
		sections.push(...toolItems.map(item => `- ${item}`));
	}

	if (assistantReplies.length) {
		sections.push('Recent assistant conclusions or replies:');
		sections.push(...assistantReplies.map(item => `- ${item}`));
	}

	return sections;
}

export function toTaskStateSections(taskState: IBeamSessionTaskState): string[] {
	const sections: string[] = [];
	if (taskState.objective) {
		sections.push('Current objective:');
		sections.push(`- ${taskState.objective}`);
	}

	if (taskState.relatedFiles.length) {
		sections.push('Current working files:');
		sections.push(...taskState.relatedFiles.map(item => `- ${item}`));
	}

	if (taskState.completed.length) {
		sections.push('Completed work:');
		sections.push(...taskState.completed.map(item => `- ${item}`));
	}

	if (taskState.pending.length) {
		sections.push('Pending work or open threads:');
		sections.push(...taskState.pending.map(item => `- ${item}`));
	}

	if (taskState.nextStep) {
		sections.push('Recommended next step:');
		sections.push(`- ${taskState.nextStep}`);
	}

	return sections;
}

export function getCurrentTaskMessageWindow(messages: readonly IBeamSessionTaskMessage[]): readonly IBeamSessionTaskMessage[] {
	let taskStartIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'user') {
			continue;
		}

		const summary = summarizeUserRequest(message);
		if (summary && !summary.isFollowUp) {
			taskStartIndex = index;
			break;
		}
	}

	return taskStartIndex >= 0 ? messages.slice(taskStartIndex) : messages;
}

export function isContinuationOnlyPrompt(value: string): boolean {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, '');

	if (!normalized) {
		return false;
	}

	return normalized === '继续'
		|| normalized === '继续做'
		|| normalized === '继续吧'
		|| normalized === '继续一下'
		|| normalized === '接着做'
		|| normalized === '继续优化'
		|| normalized === '继续执行'
		|| normalized === 'goon'
		|| normalized === 'continue'
		|| normalized === 'keepgoing'
		|| normalized === 'carryon'
		|| normalized === 'proceed';
}

function summarizeUserRequest(message: IBeamSessionTaskMessage): IUserRequestSummary | undefined {
	const rawText = String(message.content || '').replace(/\s+/g, ' ').trim();
	if (!rawText) {
		return undefined;
	}

	const text = truncateTextValue(rawText, 520);
	return {
		text,
		isFollowUp: isContinuationOnlyPrompt(text)
	};
}

function isNonEmptyString(value: string): boolean {
	return typeof value === 'string' && Boolean(value.trim());
}

function summarizeCompletedWork(toolItems: readonly string[], assistantReplies: readonly string[]): string[] {
	const results: string[] = [];

	for (const item of toolItems.slice(-4)) {
		if (isUsefulTaskStateItem(item)) {
			results.push(truncateTextValue(item, 280));
		}
	}

	for (const item of assistantReplies.slice(-2)) {
		if (isUsefulTaskStateItem(item)) {
			results.push(truncateTextValue(item, 280));
		}
	}

	return dedupeStrings(results).slice(-5);
}

function summarizeRelatedFiles(messages: readonly IBeamSessionTaskMessage[]): string[] {
	const files: string[] = [];
	for (const message of messages) {
		files.push(...extractRelatedFilesFromMessage(message));
	}

	return dedupeStrings(files).slice(-8);
}

function extractRelatedFilesFromMessage(message: IBeamSessionTaskMessage): string[] {
	if (message.role !== 'tool') {
		return [];
	}

	const base = (message.modelContent || message.content || '').trim();
	if (!base) {
		return [];
	}

	const files: string[] = [];
	for (const rawLine of base.split('\n')) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		if (line.startsWith('-- ')) {
			const candidate = normalizeRelatedFileLabel(line.slice(3));
			if (candidate) {
				files.push(candidate);
			}
			continue;
		}

		if (line.startsWith('Changed file:')) {
			const candidate = normalizeRelatedFileLabel(line.slice('Changed file:'.length));
			if (candidate) {
				files.push(candidate);
			}
			continue;
		}

		if (line.startsWith('变更文件：')) {
			const candidate = normalizeRelatedFileLabel(line.slice('变更文件：'.length));
			if (candidate) {
				files.push(candidate);
			}
			continue;
		}

		const openedMatch = line.match(/^Opened\s+(.+?),\s+positioned at line\b/i) || line.match(/^已打开\s+(.+?)，定位到第/);
		if (openedMatch?.[1]) {
			const candidate = normalizeRelatedFileLabel(openedMatch[1]);
			if (candidate) {
				files.push(candidate);
			}
		}
	}

	return files;
}

function normalizeRelatedFileLabel(value: string): string | undefined {
	const normalized = value
		.split(/\s{2,}/)[0]
		.replace(/[>,]+$/g, '')
		.trim();

	if (!normalized || /^(line|lines|whole file|code differences detected)$/i.test(normalized)) {
		return undefined;
	}

	return normalized;
}

function summarizePendingWork(thinkingItems: readonly string[], assistantReplies: readonly string[]): string[] {
	const candidates = [...thinkingItems.slice(-3), ...assistantReplies.slice(-2)]
		.filter(isUsefulTaskStateItem)
		.map(item => truncateTextValue(item, 280))
		.filter(Boolean);
	return dedupeStrings(candidates).slice(-4);
}

function summarizeNextStep(thinkingItems: readonly string[], toolItems: readonly string[], assistantReplies: readonly string[]): string | undefined {
	const candidate = thinkingItems[thinkingItems.length - 1]
		|| assistantReplies[assistantReplies.length - 1]
		|| toolItems[toolItems.length - 1];
	return candidate && isUsefulTaskStateItem(candidate) ? truncateTextValue(candidate, 320) : undefined;
}

function dedupeStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

function compactContinuationContent(message: IBeamSessionTaskMessage): string {
	const base = (message.modelContent || message.content || '').trim();
	if (!base) {
		return '';
	}

	if (message.role === 'tool') {
		const lines = base
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.filter(line =>
				line.startsWith('Summary:')
				|| line.startsWith('-- ')
				|| line.startsWith('Changed file:')
				|| line.startsWith('Location:')
				|| line.startsWith('Stats:')
				|| line.startsWith('Status:')
				|| line.startsWith('Command:')
				|| line.startsWith('Cwd:')
				|| line.startsWith('Exit code:')
			)
			.slice(0, 8);
		return truncateTextValue((lines.length ? lines : [base]).join(' | '), 700);
	}

	return truncateTextValue(base.replace(/\s+/g, ' ').trim(), message.role === 'thinking' ? 420 : 520);
}

function isUsefulTaskStateItem(value: string): boolean {
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return false;
	}

	if (/^(错误[:：]|error[:：])/i.test(normalized)) {
		return false;
	}

	if (/Beam 返回了空响应|Beam 服务暂时不可用|访问令牌无效|模型服务暂时返回了异常响应/i.test(normalized)) {
		return false;
	}

	if (/^\s*(this is a follow-up turn|latest user follow-up|additional attachments are included with this follow-up turn|preferred next step|primary objective)\b/i.test(normalized)) {
		return false;
	}

	if (/^(正在分析需求并决定先检查什么|正在根据刚才的结果继续判断下一步|正在整理检查结果并准备下一步)/.test(normalized)) {
		return false;
	}

	return true;
}

function truncateTextValue(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, Math.max(0, maxLength - 8))} ...`;
}
