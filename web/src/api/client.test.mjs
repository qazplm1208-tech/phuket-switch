import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { api, ApiFailure } from './client.ts';

test('every local management route is bound to the shared contract', async () => {
  const [doc, client] = await Promise.all([
    readFile(new URL('../../../shared/api-contract.md', import.meta.url), 'utf8'),
    readFile(new URL('client.ts', import.meta.url), 'utf8'),
  ]);
  const routes = [...doc.matchAll(/^\| `((?:GET|POST|PUT|DELETE) \/api\/[^`]+)`/gm)].map((m) => m[1]);
  const bound = [...client.matchAll(/send\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(new Set(bound), new Set(routes));
});

test('transport encodes path segments, preserves wire names and omits NoBody', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, ...init });
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({});
  });
  await api.keys({ page: 2, pageSize: 100 });
  await api.logs({ cursor: 'a + b', limit: 10 });
  await api.providers();
  await api.activateProvider('id/#?%', { applyToSystem: false });
  await api.updateProvider('existing', { name: 'edited' });
  await api.probeLocal({ providerId: 'existing' });
  assert.equal(await api.deleteMcp('codex', 'example/name'), undefined);
  assert.deepEqual(
    seen.map((v) => v.url),
    [
      '/api/phuket/keys?page=2&pageSize=100',
      '/api/proxy/logs?cursor=a+%2B+b&limit=10',
      '/api/providers',
      '/api/providers/id%2F%23%3F%25/activate',
      '/api/providers/existing',
      '/api/monitors/probe-local',
      '/api/extensions/mcp/codex/example%2Fname',
    ],
  );
  assert.deepEqual(JSON.parse(seen[4].body), { name: 'edited' });
  assert.deepEqual(JSON.parse(seen[5].body), { providerId: 'existing' });
  assert.equal(seen[0].body, undefined);
  assert.equal(seen.at(-1).body, undefined);
  assert.ok(seen.every((v) => !new Headers(v.headers).has('Authorization')));
});

test('non-success responses expose ApiErrorResponse status, code and message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { code: 'LOGIN_REQUIRED', message: '请登录' } }, { status: 401 }),
  );
  await assert.rejects(
    api.account(),
    (e) =>
      e instanceof ApiFailure &&
      e.status === 401 &&
      e.code === 'LOGIN_REQUIRED' &&
      e.message === '请登录',
  );
});

test('an HTML fallback is not silently accepted as a successful read', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<!DOCTYPE html>'));
  await assert.rejects(api.proxy(), (e) => e instanceof ApiFailure && e.code === 'INVALID_JSON');
});
