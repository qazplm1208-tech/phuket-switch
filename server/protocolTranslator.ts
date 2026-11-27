import type { ServerResponse } from 'node:http';
import { upstreamError } from './common.js';
import { finishResponse, messageUsage, outputText, records, responseItem, responseShell, stopReason, summaryText, wireId } from './protocolJson.js';
import { translateSse, type StreamBody, type StreamOptions, type Wire } from './translatedSse.js';
export { anthropicToResponsesRequest, responsesToAnthropicRequest, anthropicToResponsesResponse, responsesToAnthropicResponse } from './protocolJson.js';

interface Segment {
  index: number; output: number; block: Wire; value: string; sent: number; open: boolean; done: boolean;
}
const anthropicFailure = () => [{ type: 'error', error: { type: 'api_error', message: 'Provider stream failed.' } }];

export function streamResponsesToAnthropicSse(body: StreamBody, res: ServerResponse, model: string, options: StreamOptions) {
  const segments = new Map<string, Segment>(), pending: Segment[] = [], indices = new Map<string, number>();
  let started = false, hasTool = false;
  function segment(output: number, part: number, block: Wire) {
    const key = `${output}:${part}:${block.type}`;
    let s = segments.get(key);
    if (!s) {
      s = { index: segments.size, output, block, value: '', sent: 0, open: false, done: false };
      segments.set(key, s); pending.push(s);
      if (block.type === 'tool_use') hasTool = true;
    }
    return s;
  }
  // Responses can interleave parallel calls. Anthropic consumes one contiguous block at a time.
  function drain(events: Wire[]) {
    while (pending.length) {
      const s = pending[0], index = s.index;
      if (!s.open) { events.push({ type: 'content_block_start', index, content_block: s.block }); s.open = true; }
      if (s.value.length > s.sent) {
        const chunk = s.value.slice(s.sent); s.sent = s.value.length;
        const delta = s.block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: chunk }
          : s.block.type === 'thinking' ? { type: 'thinking_delta', thinking: chunk } : { type: 'text_delta', text: chunk };
        events.push({ type: 'content_block_delta', index, delta });
      }
      if (!s.done) break;
      events.push({ type: 'content_block_stop', index }); pending.shift();
    }
  }
  const plain = () => ({ type: 'text', text: '' }), thinking = () => ({ type: 'thinking', thinking: '', signature: '' });
  const tool = (i: Wire) => ({ type: 'tool_use', id: i.call_id ?? i.id, name: i.name, input: {} });
  function snapshot(s: Segment, value: unknown) {
    if (typeof value === 'string' && value.startsWith(s.value)) s.value = value;
  }
  function itemSnapshot(output: number, item: Wire) {
    if (item.type === 'function_call') snapshot(segment(output, 0, tool(item)), item.arguments);
    if (item.type === 'message') for (const [i, p] of records(item.content).entries()) {
      if (p.type === 'output_text' || p.type === 'refusal') snapshot(segment(output, i, plain()), p.text ?? p.refusal);
    }
    if (item.type === 'reasoning') for (const [i, p] of records(item.summary).entries()) snapshot(segment(output, i, thinking()), p.text);
  }
  function convert(v: Wire) {
    const events: Wire[] = [], t: string = v.type, r = v.response ?? {};
    if (t === 'response.failed' || t === 'error' || r.status === 'failed') return anthropicFailure();
    if (!started) {
      events.push({ type: 'message_start', message: { id: wireId('msg', r.id), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: messageUsage(r.usage) } });
      started = true;
    }
    const item = v.item ?? {}, id = item.id ?? v.item_id;
    const output = v.output_index ?? indices.get(id) ?? (t === 'response.output_item.added' ? indices.size : 0);
    if (id) indices.set(id, output);
    if (t === 'response.output_item.added' || t === 'response.output_item.done') {
      itemSnapshot(output, item);
      if (t.endsWith('.done')) for (const s of pending) if (s.output === output) s.done = true;
    } else if (t === 'response.content_part.added' || t === 'response.content_part.done' || t === 'response.reasoning_summary_part.added' || t === 'response.reasoning_summary_part.done') {
      const p = v.part ?? {};
      if (['output_text', 'refusal', 'summary_text'].includes(p.type)) {
        const s = segment(output, v.content_index ?? v.summary_index ?? 0, p.type === 'summary_text' ? thinking() : plain());
        snapshot(s, p.text ?? p.refusal); if (t.endsWith('.done')) s.done = true;
      }
    } else if (/^response\.(output_text|refusal|reasoning_summary_text|function_call_arguments)\.(delta|done)$/.test(t)) {
      const isTool = t.includes('function_call'), part = v.content_index ?? v.summary_index ?? 0;
      const s = segment(output, part, isTool ? tool({ ...v, id: v.item_id }) : t.includes('reasoning') ? thinking() : plain());
      if (t.endsWith('.delta')) { if (!s.done && typeof v.delta === 'string') s.value += v.delta; }
      else { snapshot(s, v.text ?? v.arguments ?? v.refusal); s.done = true; }
    } else if (t === 'response.completed' || t === 'response.incomplete') {
      for (const [i, item] of records(r.output).entries()) itemSnapshot(i, item);
      if (!segments.size && r.output_text) snapshot(segment(0, 0, plain()), r.output_text);
      for (const s of pending) s.done = true;
      drain(events);
      events.push({ type: 'message_delta', delta: { stop_reason: stopReason(hasTool, r.status ?? t.slice(9)), stop_sequence: null }, usage: messageUsage(r.usage) }, { type: 'message_stop' });
      return events;
    }
    drain(events); return events;
  }
  return translateSse(body, res, convert, anthropicFailure, options);
}

interface OutputBlock { index: number; item: Wire; value: string; closed: boolean }
export function streamAnthropicToResponsesSse(body: StreamBody, res: ServerResponse, model: string, options: StreamOptions) {
  const blocks = new Map<number, OutputBlock>();
  let shell: Wire, usage: Wire = {}, reason = '', sequence = 0;
  const event = (type: string, fields: Wire) => ({ type, sequence_number: sequence++, ...fields });
  const failure = () => [event('response.failed', { response: { ...(shell ?? responseShell(model)), status: 'failed', error: { code: 'server_error', message: 'Provider stream failed.' } } })];
  function start(block: Wire, sourceIndex: number, events: Wire[]) {
    if (blocks.has(sourceIndex)) throw upstreamError();
    const index = blocks.size, item = responseItem(block, `${shell.id}_${index}`);
    if (!item) return;
    const b: OutputBlock = { index, item, value: '', closed: false }; blocks.set(sourceIndex, b);
    if (item.type === 'message') item.content = [];
    if (item.type === 'function_call') item.arguments = '';
    if (item.type === 'reasoning') item.summary = [];
    if (item.status) item.status = 'in_progress';
    events.push(event('response.output_item.added', { output_index: index, item: { ...item } }));
    const loc = { item_id: item.id, output_index: index };
    if (item.type === 'message') events.push(event('response.content_part.added', { ...loc, content_index: 0, part: outputText('') }));
    if (item.type === 'reasoning') events.push(event('response.reasoning_summary_part.added', { ...loc, summary_index: 0, part: summaryText('') }));
    const initial = block.text ?? block.thinking ?? (block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '');
    if (initial) delta(b, initial, events);
  }
  function delta(b: OutputBlock, value: string, events: Wire[]) {
    if (b.closed || !value) return;
    b.value += value;
    const loc = { item_id: b.item.id, output_index: b.index, delta: value };
    if (b.item.type === 'message') events.push(event('response.output_text.delta', { ...loc, content_index: 0 }));
    if (b.item.type === 'reasoning') events.push(event('response.reasoning_summary_text.delta', { ...loc, summary_index: 0 }));
    if (b.item.type === 'function_call') events.push(event('response.function_call_arguments.delta', loc));
  }
  function stop(b: OutputBlock, events: Wire[]) {
    if (b.closed) return;
    b.closed = true;
    const { item, value } = b, loc = { item_id: item.id, output_index: b.index };
    if (item.type === 'message') {
      const part = outputText(value); item.content = [part];
      events.push(event('response.output_text.done', { ...loc, content_index: 0, text: value }), event('response.content_part.done', { ...loc, content_index: 0, part }));
    } else if (item.type === 'reasoning') {
      const part = summaryText(value); item.summary = [part];
      events.push(event('response.reasoning_summary_text.done', { ...loc, summary_index: 0, text: value }), event('response.reasoning_summary_part.done', { ...loc, summary_index: 0, part }));
    } else {
      item.arguments = value || '{}';
      events.push(event('response.function_call_arguments.done', { ...loc, name: item.name, arguments: item.arguments }));
    }
    if (item.status) item.status = 'completed';
    events.push(event('response.output_item.done', { output_index: b.index, item }));
  }
  function convert(v: Wire) {
    const events: Wire[] = [];
    if (!shell) {
      shell = responseShell(model, v.message?.id);
      events.push(event('response.created', { response: shell }), event('response.in_progress', { response: shell }));
    }
    const b = blocks.get(v.index);
    switch (v.type) {
      case 'message_start':
        usage = { ...v.message?.usage };
        for (const [i, block] of records(v.message?.content).entries()) start(block, i, events);
        break;
      case 'content_block_start': start(v.content_block, v.index, events); break;
      case 'content_block_delta': if (b) delta(b, v.delta?.text ?? v.delta?.thinking ?? v.delta?.partial_json, events); break;
      case 'content_block_stop': if (b) stop(b, events); break;
      case 'message_delta': usage = { ...usage, ...v.usage }; reason = v.delta?.stop_reason; break;
      case 'message_stop': {
        for (const b of blocks.values()) stop(b, events);
        const response = finishResponse(shell, [...blocks.values()].map(b => b.item), usage, reason);
        events.push(event(`response.${response.status}`, { response })); break;
      }
      case 'error': events.push(...failure()); break;
    }
    return events;
  }
  return translateSse(body, res, convert, failure, options);
}
