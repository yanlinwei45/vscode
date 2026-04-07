/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const DEFAULT_SYSTEM_PROMPT = '你是 Beam，一个在 VS Code 中工作的资深编码助手。请保持简洁、务实，并专注于代码与执行。';

export const PROPOSAL_ONLY_POLICY = '硬性规则：只要会引起代码或文件修改，就必须使用 Beam 的提案型工具生成可对比、可确认的编辑提议，不允许绕过确认流程直接修改工作区。run_command 只能用于只读检查、搜索或 git 查看，不能用于写入、生成或间接修改文件。如果需要修改，优先调用 create_edit_proposal，或者调用 write_file、create_file、replace_in_file 来生成对比提议，再简要说明变更意图。';

export function buildSystemPrompt(configuredPrompt?: string): string {
	return [(configuredPrompt || DEFAULT_SYSTEM_PROMPT).trim(), PROPOSAL_ONLY_POLICY].join('\n\n');
}
