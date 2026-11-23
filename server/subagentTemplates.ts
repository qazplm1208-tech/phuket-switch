import { createHash } from 'node:crypto';
import type { SubagentConfig, SubagentHarnessId } from '../shared/types.js';
import { SUBAGENT_START, SUBAGENT_END } from './subagentRules.js';

const block = (s: string) => `${SUBAGENT_START}\n${s}\n${SUBAGENT_END}`;
const limit = (c: SubagentConfig) => c.maxContextTokens.toLocaleString('en-US');
const modelPolicy = (c: SubagentConfig) => c.allowModelOverride
  ? 'A call may explicitly select a model. Omit model on continuation to keep the session model.'
  : 'Model overrides are disabled. Omit model when resuming, including sessions saved under a previous default.';
const compactionPolicy = (c: SubagentConfig) => `Automatic full compaction at ${c.compactTriggerPct}% of ${limit(c)} tokens. Compact a completed phase with astra_compact_session(session_id=..., mode="chunk", label=..., summary=...).${c.enableChunkCompaction ? ` The subagent can also call compact_context in either mode; it keeps the latest ${c.compactKeepRecentGroups} groups raw by default.` : ' Model-initiated compaction is disabled.'}`;
const notes = (c: SubagentConfig) => c.customInstructions?.trim() ? `\n\n### Workspace instructions\n${c.customInstructions.trim()}` : '';

function nativeSettings(c: SubagentConfig) {
  return `Default model: ${c.model}. Protocol: ${c.protocol}. API base: ${c.baseUrl}.\nDefault mode: ${c.defaultMode}; reasoning_effort: ${c.reasoningEffort}; context cap: ${limit(c)} tokens. ${modelPolicy(c)}`;
}
const nativeTools = `- astra_run_task: run a synchronous brief with task and absolute cwd. Reuse session_id; max_steps defaults to 30 (maximum 60).
- astra_spawn_worker: start an independent task with a worker_name. Record both worker_id and session_id; assign disjoint file ownership to parallel workers.
- astra_worker_status: inspect one worker's progress and effective model, or omit worker_id to list workers.
- astra_wait_worker: wait up to 120 seconds by default. A timed-out wait does not cancel the worker; check its status or wait again.
- astra_list_sessions: filter by cwd to find up to 30 matching sessions, newest first. Check the estimated context and last measured input before resuming.
- astra_compact_session: use session_id and force=true for an early handoff. With all_over_limit=true and no ID, scan all sessions and compact only those strictly over the requested limit.`;

export function renderSubagentRules(c: SubagentConfig, id: SubagentHarnessId) {
  if (id === 'antigravity') return block(`# Planner and coding subagent workflow

You are the planner and reviewer. Delegate implementation, refactoring, debugging and verification to the gpt-astra-subagent MCP server. Handle planning, user discussion and brief read-only inspection directly. Browser or image tasks belong to an appropriate specialist. If the configured executor is unavailable, report the failure instead of silently changing providers.

${nativeSettings(c)}

## Delegate and verify
${nativeTools}

Give the executor an absolute cwd, target files, constraints, acceptance criteria and exact build/test commands. It does not see your conversation. Set mode=readonly for an inspection: writes, edits and shell commands are blocked even though the tool schema stays stable. In edit mode run commands only for trusted local work; the shell is not an OS sandbox. Leave allow_outside_cwd=false unless the user explicitly authorizes a wider file scope.

Use one session for sequential work from planning to verification. After a restart or planner context reset, look up the active ID by cwd. Create fresh sessions only for unrelated work, an intentional reset or independent workers. Never run concurrent turns on the same session. Long history triggers a handoff that keeps the developer prefix, recent complete tool interactions and the sticky cache key. ${compactionPolicy(c)}

Review final_response, files_changed, commands_run (including exit codes), and the actual diff before reporting completion. Never put API keys in a brief, log excerpt or final report.${notes(c)}`);

  // Put operational guidance before optional free text; reserve space for both markers even with CRLF.
  const wind = id === 'windsurf';
  const brief = `Delegate coding to gpt-astra-subagent. Give astra_run_task an absolute cwd, files, constraints and tests. The planner reviews the diff, files_changed, commands_run and final_response.
Use astra_list_sessions(cwd=...) and reuse session_id for sequential work, even after restart. Omit model to keep it. Defaults: ${c.model} (${c.protocol}), ${c.defaultMode}, reasoning_effort=${c.reasoningEffort}; overrides ${c.allowModelOverride ? 'allowed' : 'disabled'}.
Use astra_spawn_worker for independent work with disjoint files and separate sessions. Poll astra_worker_status or astra_wait_worker; a 120s timeout does not cancel work.
${compactionPolicy(c)} For an early full handoff use force=true. Use readonly for inspections; edit permits trusted shell commands.`;
  const extra = wind ? '' : '\nKeep allow_outside_cwd=false unless explicitly authorized. Bulk maintenance with all_over_limit=true scans saved sessions, not just the recent listing. If a worker reaches max_steps, review its report before continuing. Report failed verification; do not substitute another provider or disclose credentials.';
  const body = brief + extra;
  // Cursor's copyable rule includes front matter outside the managed block.
  const max = wind ? 1400 : id === 'cursor' ? 1740 : 1800;
  const remaining = Math.max(0, max - block(body).replace(/\n/g, '\r\n').length);
  const custom = notes(c).replace(/\r?\n/g, '\r\n').slice(0, remaining).trimEnd().replace(/\r\n/g, '\n');
  return block(body + custom);
}

export function renderSubagentSkill(c: SubagentConfig) {
  return `---\nname: gpt-astra-orchestrator\ndescription: >-\n  Plan, delegate and verify workspace tasks with ${c.model} via ${c.protocol}.\n---

# Subagent orchestration playbook

${nativeSettings(c)}

## Tools
${nativeTools}

## Example: implementation followed by review
1. Look up the workspace with astra_list_sessions(cwd=...). Review any matching session's model, api_format and last activity. Use the plugin session_id, not prompt_cache_key, on the next call.
2. Supply a self-contained task, target modules, required invariants, and the commands that establish success. A readonly audit cannot write or run commands. Keep permissions stable unless the task calls for a change.
3. For independent modules launch named workers with separate sessions. Do not assign them overlapping files, generated outputs, or the same test database. Wait for each worker, then use the original integration session to run the combined checks.
4. Compare final_response with files_changed and commands_run. A step cap asks for a continuation, not a new session. Record what was verified and what remains open.

## Cache and maintenance
Responses uses the same sticky UUID in prompt_cache_key and the session_id HTTP header. It sends a developer item rather than replacing the endpoint's native instructions. Other adapters use their native wire formats; do not assume Responses headers or cache accounting on those protocols. Inspect usage.cache_hit_rate_pct for this turn and the session listing for cumulative hits.

${compactionPolicy(c)} Full compaction preserves the initial developer item and a tail of complete interactions, consolidates prior chunks, and uses a deterministic local handoff if the model is unavailable. Check compactions_this_turn and chunk_compactions_this_turn. A saved snapshot is backed up before replacement; the session ID and cache key survive.

## Troubleshooting
All harnesses default to ~/.gemini/antigravity/plugin_data/gpt-astra-subagent unless PLUGIN_DATA is supplied. Inspect logs/<session_id>.log for step usage, sessions/ for snapshots and session_backups/ for pre-compaction copies. Never publish snapshot or backup contents. A missing ASTRA_API_KEY must be fixed in the configured key store; do not paste it into the task. If another process is working on the session, wait before resuming.${notes(c)}\n`;
}

// Replace just the pristine template prefix from v1.2. User rules following it, and
// files that do not match the shipped text, remain subject to ordinary marker edits.
export function withoutLegacyNativeRules(src: string) {
  if (!src.replace(/^\uFEFF/, '').startsWith('# Gemini Planner + GPT-6.2-Astra Subagent Workflow')) return src;
  const prefix = /^(?:[^\n]*\n){33}[^\n]*(?:\n|$)/.exec(src)?.[0] ?? '';
  const normalized = prefix.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized).digest('hex') === '051ba6136776fa0e1b3d1fdf4c60f25bd67bf85a67104c03667a847041b8ff0f' ? src.slice(prefix.length) : src;
}
