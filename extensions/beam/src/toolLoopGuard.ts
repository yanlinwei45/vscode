/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IBeamToolLoopUse {
	readonly name: string;
	readonly input?: unknown;
}

export interface IBeamToolLoopDecision {
	readonly shouldStop: boolean;
	readonly reason?: string;
}

export interface IBeamToolLoopGuardOptions {
	readonly simpleQuery?: boolean;
}

const INVESTIGATION_TOOL_NAMES = new Set([
	'get_active_editor_context',
	'read_file',
	'list_directory',
	'search_workspace',
	'get_diagnostics',
	'open_file',
	'select_editor_range',
	'select_current_function',
	'select_current_block',
	'reveal_range',
	'run_command'
]);

const MAX_IDENTICAL_INVESTIGATION_ROUND_REPEATS = 2;
const MAX_REPEATED_INVESTIGATION_SIGNATURE_COUNT = 2;
const MAX_CONSECUTIVE_INVESTIGATION_ROUNDS = 12;
const MAX_HEAVY_INVESTIGATION_ROUNDS = 4;
const MAX_DIRECTORY_HEAVY_ROUNDS = 3;
const MAX_COMMAND_HEAVY_ROUNDS = 3;
const MAX_INVESTIGATION_TOOLS_PER_ROUND = 8;
const MAX_TOTAL_TOOL_ROUNDS = 80;
const MAX_RECENT_INVESTIGATION_SIGNATURES = 24;
const SIMPLE_QUERY_MAX_CONSECUTIVE_INVESTIGATION_ROUNDS = 5;
const SIMPLE_QUERY_MAX_HEAVY_INVESTIGATION_ROUNDS = 2;
const SIMPLE_QUERY_MAX_DIRECTORY_HEAVY_ROUNDS = 2;
const SIMPLE_QUERY_MAX_COMMAND_HEAVY_ROUNDS = 2;
const SIMPLE_QUERY_MAX_INVESTIGATION_TOOLS_PER_ROUND = 4;

export class BeamToolLoopGuard {

	private totalRounds = 0;
	private previousRoundSignature: string | undefined;
	private consecutiveIdenticalInvestigationRounds = 0;
	private consecutiveInvestigationRounds = 0;
	private consecutiveHeavyInvestigationRounds = 0;
	private consecutiveDirectoryHeavyRounds = 0;
	private consecutiveCommandHeavyRounds = 0;
	private recentInvestigationRoundSignatures: string[] = [];

	constructor(private readonly options: IBeamToolLoopGuardOptions = {}) { }

	register(toolUses: readonly IBeamToolLoopUse[]): IBeamToolLoopDecision {
		if (!toolUses.length) {
			return { shouldStop: false };
		}

		this.totalRounds += 1;

		const toolSignatures = toolUses.map(toolUse => toToolSignature(toolUse));
		const roundSignature = toolSignatures.join(' | ');
		const investigationOnly = toolUses.every(toolUse => INVESTIGATION_TOOL_NAMES.has(toolUse.name));
		const directoryReadCount = toolUses.filter(toolUse => toolUse.name === 'list_directory').length;
		const fileReadCount = toolUses.filter(toolUse => toolUse.name === 'read_file').length;
		const searchCount = toolUses.filter(toolUse => toolUse.name === 'search_workspace').length;
		const diagnosticsCount = toolUses.filter(toolUse => toolUse.name === 'get_diagnostics').length;
		const commandCount = toolUses.filter(toolUse => toolUse.name === 'run_command').length;
		const heavyInvestigationToolCount = directoryReadCount + fileReadCount + searchCount + diagnosticsCount + commandCount;
		const heavyInvestigationRound = investigationOnly && toolUses.length >= 3 && heavyInvestigationToolCount === toolUses.length;
		const directoryHeavyRound = investigationOnly && directoryReadCount >= 2 && directoryReadCount >= fileReadCount;
		const commandHeavyRound = investigationOnly && commandCount >= 1 && (commandCount + fileReadCount + searchCount + diagnosticsCount) === toolUses.length;

		if (investigationOnly && roundSignature && roundSignature === this.previousRoundSignature) {
			this.consecutiveIdenticalInvestigationRounds += 1;
		} else {
			this.consecutiveIdenticalInvestigationRounds = 0;
		}
		this.previousRoundSignature = roundSignature || undefined;

		if (investigationOnly) {
			this.consecutiveInvestigationRounds += 1;
			this.consecutiveHeavyInvestigationRounds = heavyInvestigationRound ? this.consecutiveHeavyInvestigationRounds + 1 : 0;
			this.consecutiveDirectoryHeavyRounds = directoryHeavyRound ? this.consecutiveDirectoryHeavyRounds + 1 : 0;
			this.consecutiveCommandHeavyRounds = commandHeavyRound ? this.consecutiveCommandHeavyRounds + 1 : 0;
			const previousRoundSignature = this.recentInvestigationRoundSignatures[this.recentInvestigationRoundSignatures.length - 1];
			if (roundSignature && roundSignature !== previousRoundSignature) {
				this.recentInvestigationRoundSignatures.push(roundSignature);
			}
			if (this.recentInvestigationRoundSignatures.length > MAX_RECENT_INVESTIGATION_SIGNATURES) {
				this.recentInvestigationRoundSignatures = this.recentInvestigationRoundSignatures.slice(-MAX_RECENT_INVESTIGATION_SIGNATURES);
			}
		} else {
			this.consecutiveInvestigationRounds = 0;
			this.consecutiveHeavyInvestigationRounds = 0;
			this.consecutiveDirectoryHeavyRounds = 0;
			this.consecutiveCommandHeavyRounds = 0;
			this.recentInvestigationRoundSignatures = [];
		}

		if (investigationOnly && this.consecutiveIdenticalInvestigationRounds >= MAX_IDENTICAL_INVESTIGATION_ROUND_REPEATS) {
			return {
				shouldStop: true,
				reason: 'The model is repeating the same investigation tool sequence without making new progress.'
			};
		}

		if (investigationOnly && toolUses.length === 1) {
			for (const signature of toolSignatures) {
				const repeatCount = this.recentInvestigationRoundSignatures.filter(value => value.includes(signature)).length;
				if (repeatCount >= MAX_REPEATED_INVESTIGATION_SIGNATURE_COUNT) {
					return {
						shouldStop: true,
						reason: `The investigation keeps repeating the same tool input (${signature}) without enough new information.`
					};
				}
			}
		}

		if (investigationOnly && toolUses.length > this.getMaxInvestigationToolsPerRound()) {
			return {
				shouldStop: true,
				reason: 'The model requested too many investigation actions in a single round instead of narrowing down the next best step.'
			};
		}

		if (investigationOnly && this.consecutiveInvestigationRounds >= this.getMaxConsecutiveInvestigationRounds()) {
			return {
				shouldStop: true,
				reason: 'The investigation has continued for many rounds without switching from search/inspection into a final answer.'
			};
		}

		if (this.consecutiveHeavyInvestigationRounds >= this.getMaxHeavyInvestigationRounds()) {
			return {
				shouldStop: true,
				reason: 'The model has spent too many rounds only reading files and searching without moving to a conclusion or edit.'
			};
		}

		if (this.consecutiveDirectoryHeavyRounds >= this.getMaxDirectoryHeavyRounds()) {
			return {
				shouldStop: true,
				reason: 'The model keeps expanding directories instead of concluding from the files it already inspected.'
			};
		}

		if (this.consecutiveCommandHeavyRounds >= this.getMaxCommandHeavyRounds()) {
			return {
				shouldStop: true,
				reason: 'The model keeps running read-only commands instead of concluding from the evidence it already collected.'
			};
		}

		if (this.totalRounds >= MAX_TOTAL_TOOL_ROUNDS) {
			return {
				shouldStop: true,
				reason: 'The tool loop has become too long, so Beam should conclude from the evidence already collected.'
			};
		}

		return { shouldStop: false };
	}

	private getMaxConsecutiveInvestigationRounds(): number {
		return this.options.simpleQuery ? SIMPLE_QUERY_MAX_CONSECUTIVE_INVESTIGATION_ROUNDS : MAX_CONSECUTIVE_INVESTIGATION_ROUNDS;
	}

	private getMaxHeavyInvestigationRounds(): number {
		return this.options.simpleQuery ? SIMPLE_QUERY_MAX_HEAVY_INVESTIGATION_ROUNDS : MAX_HEAVY_INVESTIGATION_ROUNDS;
	}

	private getMaxDirectoryHeavyRounds(): number {
		return this.options.simpleQuery ? SIMPLE_QUERY_MAX_DIRECTORY_HEAVY_ROUNDS : MAX_DIRECTORY_HEAVY_ROUNDS;
	}

	private getMaxCommandHeavyRounds(): number {
		return this.options.simpleQuery ? SIMPLE_QUERY_MAX_COMMAND_HEAVY_ROUNDS : MAX_COMMAND_HEAVY_ROUNDS;
	}

	private getMaxInvestigationToolsPerRound(): number {
		return this.options.simpleQuery ? SIMPLE_QUERY_MAX_INVESTIGATION_TOOLS_PER_ROUND : MAX_INVESTIGATION_TOOLS_PER_ROUND;
	}
}

function toToolSignature(toolUse: IBeamToolLoopUse): string {
	return `${toolUse.name}:${stableStringify(toolUse.input ?? {})}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(item => stableStringify(item)).join(',')}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
	return `{${entries.join(',')}}`;
}
