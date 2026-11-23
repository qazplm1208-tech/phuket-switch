import { randomUUID } from 'node:crypto';
import type { GptFastConfig, Provider } from '../shared/types.js';
import { bad, isRecord, upstreamError } from './common.js';
import { rewriteResponses } from './fastMode.js';
import type { Wire } from './translatedSse.js';

export const records = (v: unknown): Wire[] => Array.isArray(v) ? v.filter(isRecord) : [];
const text = (v: unknown): string => typeof v === 'string' ? v : records(v).map(b => b.text).filter(s => typeof s === 'string').join('\n');
const blocks = (v: unknown) => typeof v === 'string' ? [{ type: 'text', text: v }] : records(v);
const objectSchema = () => ({ type: 'object', properties: {} });
const toolOutput = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v) && v.every(b => b?.type === 'text') ? text(v) : JSON.stringify(v ?? '');
export const wireId = (prefix: string, id?: string) => id?.startsWith(prefix + '_') ? id : `${prefix}_${id || randomUUID()}`;
function toolInput(v: unknown, fromClient = false): Wire {
  try {
    const input: unknown = typeof v === 'string' ? JSON.parse(v || '{}') : v ?? {};
    if (isRecord(input)) return input;
  } catch { /* never include tool arguments in error messages or logs */ }
  throw fromClient ? bad('Expected a JSON object for function arguments.') : upstreamError();
}
function sampling(body: Wire) {
  return { ...(body.temperature != null && { temperature: body.temperature }), ...(body.top_p != null && { top_p: body.top_p }), stream: Boolean(body.stream) };
}
function imageUrl(source?: Wire) {
  if (source?.type === 'base64') return `data:${source.media_type};base64,${source.data}`;
  if (source?.type === 'url') return source.url;
}
function messageBlocks(content: unknown): Wire[] {
  const result: Wire[] = [];
  for (const b of blocks(content)) {
    if (['text', 'input_text', 'output_text'].includes(b.type) && b.text) result.push({ type: 'text', text: b.text });
    if (b.type === 'input_image' && typeof b.image_url === 'string') {
      const match = /^data:([^;,]+);base64,/i.exec(b.image_url);
      const source = match ? { type: 'base64', media_type: match[1], data: b.image_url.slice(match[0].length) } : { type: 'url', url: b.image_url };
      result.push({ type: 'image', source });
    }
  }
  return result;
}

export function anthropicToResponsesRequest(body: Wire, targetModel: string, provider: Provider, fastConfig: GptFastConfig): Wire {
  const input: Wire[] = [];
  for (const m of records(body.messages)) {
    const assistant = m.role === 'assistant';
    if (!assistant && m.role !== 'user') continue;
    let content: Wire[] = [];
    const flush = () => { if (content.length) input.push({ type: 'message', role: m.role, content }); content = []; };
    for (const b of blocks(m.content)) {
      if (b.type === 'text') content.push({ type: assistant ? 'output_text' : 'input_text', text: b.text });
      else if (!assistant && b.type === 'image') {
        const url = imageUrl(b.source); if (url) content.push({ type: 'input_image', image_url: url });
      } else if (!assistant && b.type === 'tool_result') {
        flush(); input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolOutput(b.content) });
      } else if (assistant && b.type === 'tool_use') {
        flush(); input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    }
    flush();
  }
  const choice = typeof body.tool_choice === 'string' ? { type: body.tool_choice } : body.tool_choice;
  const tools = records(body.tools).filter(t => typeof t.name === 'string' && t.input_schema).map(t => ({
    type: 'function', name: t.name, description: t.description, parameters: t.input_schema,
  }));
  const out: Wire = { model: targetModel, input, ...sampling(body), store: false };
  if (body.system != null) out.instructions = text(body.system);
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
  if (tools.length) out.tools = tools;
  if (choice?.type === 'tool') out.tool_choice = { type: 'function', name: choice.name };
  else if (choice?.type === 'any') out.tool_choice = 'required';
  else if (choice?.type === 'auto' || choice?.type === 'none') out.tool_choice = choice.type;
  if (typeof choice?.disable_parallel_tool_use === 'boolean') out.parallel_tool_calls = !choice.disable_parallel_tool_use;
  return rewriteResponses(out, fastConfig, provider);
}

export function responsesToAnthropicRequest(body: Wire, targetModel: string): Wire {
  const system = [text(body.instructions)].filter(Boolean), messages: { role: string; content: Wire[] }[] = [];
  const add = (role: string, content: Wire[]) => {
    if (!content.length) return;
    if (messages.at(-1)?.role !== role) messages.push({ role, content: [] });
    messages.at(-1)!.content.push(...content);
  };
  if (typeof body.input === 'string') add('user', messageBlocks(body.input));
  for (const m of records(body.input)) {
    if (m.role === 'developer' || m.role === 'system') { const s = text(m.content); if (s) system.push(s); }
    else if (m.type === 'function_call') add('assistant', [{ type: 'tool_use', id: m.call_id, name: m.name, input: toolInput(m.arguments, true) }]);
    else if (m.type === 'function_call_output') {
      const rich = Array.isArray(m.output) && messageBlocks(m.output);
      add('user', [{ type: 'tool_result', tool_use_id: m.call_id, content: rich && rich.length ? rich : toolOutput(m.output) }]);
    } else if (m.role === 'assistant' || m.role === 'user') add(m.role, messageBlocks(m.content));
    // OpenAI reasoning items cannot be replayed as signed Anthropic thinking blocks.
  }
  // Messages requires tool results first in the merged user turn.
  for (const m of messages) if (m.role === 'user') m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  const out: Wire = { model: targetModel, messages, max_tokens: body.max_output_tokens ?? 8192, ...sampling(body) };
  if (system.length) out.system = system.join('\n\n');
  const tools = records(body.tools).filter(t => t.type === 'function' && t.name).map(t => ({ name: t.name, description: t.description, input_schema: t.parameters ?? objectSchema() }));
  if (tools.length) {
    out.tools = tools;
    const c = body.tool_choice;
    if (c === 'auto' || c === 'none') out.tool_choice = { type: c };
    else if (c === 'required') out.tool_choice = { type: 'any' };
    else if (c?.type === 'function' && tools.some(t => t.name === c.name)) out.tool_choice = { type: 'tool', name: c.name };
    if (body.parallel_tool_calls === false && out.tool_choice?.type !== 'none') out.tool_choice = { type: 'auto', ...out.tool_choice, disable_parallel_tool_use: true };
  }
  return out;
}

export const messageUsage = (usage?: Wire) => ({ input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 });
export const stopReason = (hasTool: boolean, status: string) => hasTool ? 'tool_use' : status === 'incomplete' ? 'max_tokens' : 'end_turn';
export function responsesToAnthropicResponse(r: Wire, model: string): Wire {
  if (r.status === 'failed' || (!Array.isArray(r.output) && typeof r.output_text !== 'string')) throw upstreamError();
  const content: Wire[] = [];
  for (const item of records(r.output)) {
    if (item.type === 'message') for (const b of records(item.content)) {
      if (b.type === 'output_text' || b.type === 'refusal') content.push({ type: 'text', text: b.text ?? b.refusal });
    }
    if (item.type === 'output_text') content.push({ type: 'text', text: item.text });
    if (item.type === 'function_call') content.push({ type: 'tool_use', id: item.call_id ?? item.id, name: item.name, input: toolInput(item.arguments) });
    if (item.type === 'reasoning') for (const b of records(item.summary)) content.push({ type: 'thinking', thinking: b.text, signature: '' });
  }
  if (!content.length && r.output_text) content.push({ type: 'text', text: r.output_text });
  return { id: wireId('msg', r.id), type: 'message', role: 'assistant', model, content, stop_reason: stopReason(content.some(b => b.type === 'tool_use'), r.status), stop_sequence: null, usage: messageUsage(r.usage) };
}
export function responseUsage(usage: Wire) {
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0), output = usage.output_tokens ?? 0;
  return { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output };
}
export const outputText = (t: string) => ({ type: 'output_text', text: t, annotations: [] });
export const summaryText = (t: string) => ({ type: 'summary_text', text: t });
export function responseShell(model: string, id?: string): Wire {
  return { id: wireId('resp', id), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, error: null, incomplete_details: null, output: [], output_text: '', usage: null };
}
export function responseItem(block: Wire, id: string): Wire | undefined {
  if (block.type === 'text') return { id: wireId('msg', id), type: 'message', role: 'assistant', status: 'completed', content: [outputText(block.text)] };
  if (block.type === 'thinking') return { id: wireId('rs', id), type: 'reasoning', summary: [summaryText(block.thinking)] };
  if (block.type === 'tool_use') return { id: wireId('fc', id), type: 'function_call', status: 'completed', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) };
}
export function finishResponse(shell: Wire, output: Wire[], usage: Wire, reason: string): Wire {
  const incomplete = reason === 'max_tokens' || reason === 'model_context_window_exceeded';
  return { ...shell, status: incomplete ? 'incomplete' : 'completed', incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, output, output_text: output.flatMap(i => records(i.content).map(b => b.text)).join(''), usage: responseUsage(usage) };
}
export function anthropicToResponsesResponse(msg: Wire, model: string): Wire {
  if (!Array.isArray(msg.content)) throw upstreamError();
  const shell = responseShell(model, msg.id), output = records(msg.content).flatMap((b, i) => responseItem(b, `${shell.id}_${i}`) ?? []);
  return finishResponse(shell, output, msg.usage ?? {}, msg.stop_reason);
}
