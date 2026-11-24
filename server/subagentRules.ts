import { markedRule } from './markedRule.js';

export const SUBAGENT_START = '<!-- PHUKET_SWITCH_SUBAGENT_START -->';
export const SUBAGENT_END = '<!-- PHUKET_SWITCH_SUBAGENT_END -->';
export const { read: subagentBlock, edit: editSubagentBlock } = markedRule(SUBAGENT_START, SUBAGENT_END, 'subagent');
