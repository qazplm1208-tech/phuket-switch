import { asNumber, isRecord, own } from './common.js';

// Bounded SSE event decoder. Oversized events are skipped for telemetry, never
// withheld from the proxy client. Handles split UTF-8, delimiters and multiline data.
export class StreamMetrics {
  private readonly decoder = new TextDecoder();
  private line = ''; private data: string[] = []; private size = 0; private discard = false; private pendingCR = false;
  firstByteMs: number | null = null; firstTokenMs: number | null = null;
  outputTokens: number | null = null; inputTokens: number | null = null; totalTokens: number | null = null;
  text = ''; failed = false;
  constructor(private readonly start: number, private readonly textLimit = 0) {}
  private time() { return Math.round(performance.now() - this.start); }
  private token(value: unknown) {
    if (typeof value !== 'string' || !value) return;
    this.firstTokenMs ??= this.time();
    if (this.text.length < this.textLimit) this.text += value.slice(0, this.textLimit - this.text.length);
  }
  observe(value: unknown, event = '') {
    const v = own(value), type = v.type || event, response = own(v.response ?? v.message);
    const usage = own(v.usageMetadata ?? response.usage ?? v.usage);
    this.inputTokens = asNumber(usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens) ?? this.inputTokens;
    this.outputTokens = asNumber(usage.candidatesTokenCount ?? usage.output_tokens ?? usage.completion_tokens) ?? this.outputTokens;
    this.totalTokens = asNumber(usage.totalTokenCount ?? usage.total_tokens) ?? (this.inputTokens !== null && this.outputTokens !== null ? this.inputTokens + this.outputTokens : this.totalTokens);
    if (Array.isArray(v.candidates)) for (const candidate of v.candidates) {
      if (Array.isArray(candidate?.content?.parts)) for (const part of candidate.content.parts) this.token(part?.text);
    }
    if (type === 'response.output_text.delta') this.token(v.delta);
    else if (type === 'response.function_call_arguments.delta' || type === 'response.reasoning_summary_text.delta') this.token(v.delta);
    else if (type === 'content_block_delta') this.token(v.delta?.text ?? v.delta?.partial_json ?? v.delta?.thinking);
    else if (Array.isArray(v.choices)) this.token(v.choices[0]?.delta?.content ?? v.choices[0]?.message?.content);
    if (type === 'response.failed' || type === 'error' || response.status === 'failed' || isRecord(v.error)) this.failed = true;
    if (this.firstTokenMs === null) {
      const output = response.output ?? v.output;
      if (Array.isArray(output)) for (const item of output) if (Array.isArray(item?.content)) for (const p of item.content) this.token(p?.text);
      if (Array.isArray(v.content)) for (const block of v.content) this.token(block?.text);
      if (typeof v.output_text === 'string' && this.firstTokenMs === null) this.token(v.output_text);
    }
  }
  private event = '';
  private endLine() {
    if (!this.line) {
      if (this.data.length && !this.discard) {
        try { const obj: unknown = JSON.parse(this.data.join('\n')); if (isRecord(obj)) this.observe(obj, this.event); } catch { /* heartbeat / [DONE] */ }
      }
      this.data = []; this.discard = false; this.size = 0; this.event = '';
    } else if (!this.discard) {
      if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
      if (this.line.startsWith('event:')) this.event = this.line.slice(6).trim();
    }
    this.line = '';
  }
  private feed(s: string) {
    if (!s.length) return;
    if (this.pendingCR && s.startsWith('\n')) s = s.slice(1);
    this.pendingCR = s.endsWith('\r');
    if (!s.length) return;
    const pieces = s.split(/\r\n|\n|\r/);
    for (let i = 0; i < pieces.length; i++) {
      this.size += pieces[i].length;
      if (this.size > 256 * 1024) this.discard = true;
      if (!this.discard) this.line += pieces[i]; else if (pieces[i]) this.line = '*';
      if (i < pieces.length - 1) this.endLine();
    }
  }
  push(chunk: Uint8Array) { this.firstByteMs ??= this.time(); this.feed(this.decoder.decode(chunk, { stream: true })); }
  finish() { this.feed(this.decoder.decode()); this.endLine(); this.endLine(); }
}
