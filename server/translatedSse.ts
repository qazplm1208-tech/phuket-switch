import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { elapsed, isRecord, upstreamError } from './common.js';
import { StreamMetrics } from './streamMetrics.js';

export type Wire = Record<string, any>;
export type StreamBody = NonNullable<Response['body']>;
export type OnMetrics = (metrics: { ttftMs: number | null; totalTokens: number | null; failed: boolean }) => void;
export interface StreamOptions { start?: number; signal?: AbortSignal }

// Decode by line, not by network chunk. Bound a single unfinished event, not the stream.
async function* frames(body: StreamBody): AsyncGenerator<Wire> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pieces: string[] = [], data: string[] = [], event = '', size = 0, cr = false, eof = false;
  function* line(value: string) {
    if (!value) {
      if (data.length) {
        const raw = data.join('\n');
        if (raw.trim() !== '[DONE]') {
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) throw upstreamError();
          yield { ...parsed, type: parsed.type || event };
        }
      }
      data = []; event = ''; size = 0;
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    else if (value.startsWith('event:')) event = value.slice(6).trim();
  }
  try {
    for (;;) {
      const { value, done } = await reader.read(); eof = done;
      let text = decoder.decode(value, { stream: !done });
      if (text) {
        if (cr && text[0] === '\n') text = text.slice(1);
        cr = text.endsWith('\r');
        const lines = text.split(/\r\n|\r|\n/);
        for (const [i, part] of lines.entries()) {
          size += part.length + 1;
          if (size > 16 * 1024 * 1024) throw upstreamError();
          if (part) pieces.push(part);
          if (i < lines.length - 1) { yield* line(pieces.join('')); pieces = []; }
        }
      }
      if (done) { if (pieces.length) yield* line(pieces.join('')); yield* line(''); return; }
    }
  } finally {
    if (!eof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const terminal = new Set(['message_stop', 'response.completed', 'response.incomplete', 'response.failed', 'error']);
export async function translateSse(body: StreamBody, res: ServerResponse, convert: (v: Wire) => Wire[], failure: () => Wire[], onMetrics: OnMetrics, { start = performance.now(), signal }: StreamOptions) {
  const metrics = new StreamMetrics(start);
  const write = async (v: Wire) => {
    if (res.destroyed || signal?.aborted) throw upstreamError();
    if (!res.write(`event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`)) await once(res, 'drain', { signal });
  };
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    for await (const v of frames(body)) {
      metrics.firstByteMs ??= elapsed(start);
      metrics.observe(v);
      for (const out of convert(v)) {
        await write(out);
        if (terminal.has(out.type)) {
          metrics.observe(out);
          res.end(); return;
        }
      }
    }
    throw upstreamError(); // EOF is not a successful message_stop / response.completed.
  } catch (e) {
    metrics.failed = true;
    if (res.destroyed || signal?.aborted) throw e;
    for (const out of failure()) await write(out);
    res.end();
  } finally {
    onMetrics({ ttftMs: metrics.firstTokenMs ?? metrics.firstByteMs, totalTokens: metrics.totalTokens, failed: metrics.failed });
  }
}
