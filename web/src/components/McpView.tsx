import { useState } from 'react';
import type { FormEvent } from 'react';
import { Cable, Pencil, Plus, Save, Terminal, Trash2 } from 'lucide-react';
import type { McpServerItem, McpTarget, McpTransport } from '@shared/types';
import { api } from '../api/client';
import { useAction, useFeedback } from '../lib/feedback';
import { messageOf, useResource } from '../lib/resource';
import { Badge, Btn, Empty, Field, IconBtn, Modal, Notice, Section, Skeleton } from './ui';
function dictionary(text: string): Record<string, string> {
  const v: unknown = JSON.parse(text.trim() || '{}');
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string'))
    throw new Error('环境变量和请求头 必须是值为字符串的 JSON 对象。');
  return v as Record<string, string>;
}
function Editor({ item, close, saved }: { item?: McpServerItem; close: () => void; saved: () => void }) {
  const t = item?.transport;
  const [name, setName] = useState(item?.name ?? ''),
    [target, setTarget] = useState<McpTarget>(item?.target ?? 'claude'),
    [type, setType] = useState<McpTransport['type']>(t?.type ?? 'stdio'),
    [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [command, setCmd] = useState(t?.type === 'stdio' ? t.command : ''),
    [args, setArgs] = useState(JSON.stringify(t?.type === 'stdio' ? (t.args ?? []) : [], null, 2)),
    [url, setUrl] = useState(t && t.type !== 'stdio' ? t.url : ''),
    [env, setEnv] = useState(JSON.stringify(t?.type === 'stdio' ? (t.env ?? {}) : {}, null, 2)),
    [headers, setHeaders] = useState(
      JSON.stringify(t && t.type !== 'stdio' ? (t.headers ?? {}) : {}, null, 2),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const { notify } = useFeedback();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!name.trim()) throw new Error('请输入服务器名称。');
      let transport: McpTransport;
      if (type === 'stdio') {
        const a: unknown = JSON.parse(args || '[]');
        if (!Array.isArray(a) || a.some((v) => typeof v !== 'string') || !command.trim())
          throw new Error('请填写启动命令，并以字符串数组提供参数。');
        transport = { type, command: command.trim(), args: a, env: dictionary(env) };
      } else {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) throw new Error('请输入 HTTP(S) URL。');
        transport = { type, url: url.trim(), headers: dictionary(headers) };
      }
      await api.upsertMcp({ target, name: name.trim(), enabled, transport });
      notify('MCP 服务器已保存');
      saved();
      close();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={item ? '编辑 MCP 服务器' : '添加 MCP 服务器'} close={close} busy={busy}>
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="名称">
            <input
              value={name}
              autoFocus
              required
              disabled={!!item}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="目标客户端">
            <select value={target} disabled={!!item} onChange={(e) => setTarget(e.target.value as McpTarget)}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
        </div>
        <Field label="传输类型">
          <select value={type} onChange={(e) => setType(e.target.value as McpTransport['type'])}>
            {['stdio', 'http', 'sse'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        {type === 'stdio' ? (
          <>
            <Field label="启动命令">
              <input className="mono" required value={command} onChange={(e) => setCmd(e.target.value)} />
            </Field>
            <Field label="参数 · JSON 字符串数组">
              <textarea
                className="mono"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field label="环境变量 · JSON 对象">
              <textarea
                className="mono"
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                spellCheck={false}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="服务 URL">
              <input
                className="mono"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field label="请求头 · JSON 对象">
              <textarea
                className="mono"
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                spellCheck={false}
              />
            </Field>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用服务器
        </label>
        {error && <Notice tone="bad">{error}</Notice>}
        <footer className="modal-foot">
          <Btn disabled={busy} onClick={close}>
            取消
          </Btn>
          <Btn type="submit" kind="primary" icon={Save} busy={busy}>
            保存
          </Btn>
        </footer>
      </form>
    </Modal>
  );
}
export default function McpView() {
  const r = useResource('mcp', api.mcp),
    { pending, run } = useAction(),
    { notify, confirm } = useFeedback();
  const [editor, setEditor] = useState<McpServerItem | 'new' | null>(null);
  return (
    <>
      <Section
        title="MCP 服务器"
        count={r.data?.length}
        actions={
          <Btn kind="primary" icon={Plus} onClick={() => setEditor('new')}>
            添加服务器
          </Btn>
        }
      />
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.loading && !r.data ? (
        <Skeleton />
      ) : r.data?.length ? (
        <div className="grouped-list">
          {r.data.filter(Boolean).map((m) => (
            <article className="setting-row" key={m.id}>
              <Cable size={16} />
              <div className="grow">
                <h3>{m.name}</h3>
                <small>
                  {m.target === 'claude' ? 'Claude Code' : 'Codex'} · {m.transport.type} ·{' '}
                  <code>{m.transport.type === 'stdio' ? m.transport.command : m.transport.url}</code>
                </small>
              </div>
              <Badge tone={m.enabled ? 'good' : 'muted'} dot>
                {m.enabled ? '已启用' : '已停用'}
              </Badge>
              <div className="actions end">
                <IconBtn icon={Pencil} label="编辑 MCP" onClick={() => setEditor(m)} />
                <IconBtn
                  icon={Trash2}
                  label="删除 MCP"
                  disabled={!!pending}
                  onClick={() =>
                    void run('del', async () => {
                      if (!(await confirm('删除 MCP 服务器？', `从 ${m.target} 移除「${m.name}」。`, '删除')))
                        return;
                      await api.deleteMcp(m.target, m.name);
                      r.reload();
                      notify('服务器已删除');
                    })
                  }
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        !r.error && <Empty icon={Terminal} title="尚未配置 MCP 服务器" />
      )}
      {editor && (
        <Editor item={editor === 'new' ? undefined : editor} close={() => setEditor(null)} saved={r.reload} />
      )}
    </>
  );
}
