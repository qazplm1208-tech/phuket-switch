import { useState } from 'react';
import { Check, FileCode2, FilePenLine, Plus, Save, Trash2 } from 'lucide-react';
import type { PromptPreset } from '@shared/types';
import { api } from '../api/client';
import { systemNote } from '../lib/display';
import { useFeedback, useAction } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { Badge, Btn, Empty, Field, IconBtn, Notice, Section, Skeleton } from './ui';
const filename = (a: string) => (a === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
export default function PromptView() {
  const r = useResource('prompts', api.prompts),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const [id, setId] = useState<string | null>(null),
    [fresh, setFresh] = useState(false),
    [name, setName] = useState(''),
    [content, setContent] = useState(''),
    [app, setApp] = useState<'claude' | 'codex'>('claude'),
    [dirty, setDirty] = useState(false);
  const active = r.data?.find((p) => p.id === id) ?? (!fresh ? r.data?.[0] : undefined),
    n = dirty || fresh ? name : (active?.name ?? ''),
    text = dirty || fresh ? content : (active?.content ?? '');
  function draft(nm: string, txt: string) {
    setName(nm);
    setContent(txt);
    setDirty(true);
  }
  async function choose(p?: PromptPreset) {
    if (dirty && !(await confirm('放弃未保存编辑？', '当前编辑的提示词尚未保存。', '放弃编辑'))) return;
    setDirty(false);
    setFresh(!p);
    setId(p?.id ?? null);
    setName(p?.name ?? '');
    setContent(p?.content ?? '');
    setApp(p?.appType === 'codex' ? 'codex' : 'claude');
  }
  return (
    <>
      <Section
        title="系统提示词"
        count={r.data?.length}
        actions={
          <Btn icon={Plus} disabled={!!pending} onClick={() => void choose()}>
            新建预设
          </Btn>
        }
      />
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.loading && !r.data ? (
        <Skeleton />
      ) : (
        <div className="prompt-layout">
          <div className="prompt-list">
            {(r.data ?? []).map((p) => (
              <button
                key={p.id}
                className={!fresh && active?.id === p.id ? 'selected' : ''}
                onClick={() => void choose(p)}
              >
                <FileCode2 size={16} />
                <span>
                  <b>{p.name}</b>
                  <code>{filename(p.appType)}</code>
                </span>
                {p.enabled && <Check size={13} className="good" />}
              </button>
            ))}
          </div>
          {active || fresh ? (
            <div className="editor-pane">
              <div className="form-grid">
                <Field label="预设名称">
                  <input value={n} onChange={(e) => draft(e.target.value, text)} />
                </Field>
                {fresh ? (
                  <Field label="目标文件">
                    <select value={app} onChange={(e) => setApp(e.target.value as 'claude' | 'codex')}>
                      <option value="claude">CLAUDE.md</option>
                      <option value="codex">AGENTS.md</option>
                    </select>
                  </Field>
                ) : (
                  <div className="editor-target">
                    <Badge>{filename(active?.appType ?? 'claude')}</Badge>
                  </div>
                )}
              </div>
              <Field label="Markdown">
                <textarea
                  className="markdown-editor mono"
                  value={text}
                  spellCheck={false}
                  onChange={(e) => draft(n, e.target.value)}
                  placeholder="# 工作指引"
                />
              </Field>
              <div className="actions">
                <Btn
                  kind="primary"
                  icon={Save}
                  disabled={!!pending || !n.trim() || !text.trim()}
                  busy={pending === 'save'}
                  onClick={() =>
                    void run('save', async () => {
                      const p = fresh
                        ? await api.createPrompt({ name: n.trim(), content: text, appType: app })
                        : await api.updatePrompt(active!.id, { name: n.trim(), content: text });
                      r.replace([...(r.data ?? []).filter((x) => x.id !== p.id), p]);
                      setId(p.id);
                      setFresh(false);
                      setDirty(false);
                      notify('预设已保存');
                    })
                  }
                >
                  保存
                </Btn>
                <Btn
                  icon={FilePenLine}
                  disabled={!!pending || fresh || dirty || !active}
                  title={dirty ? '请先保存修改' : undefined}
                  onClick={() =>
                    void run('apply', async () => {
                      if (
                        !active ||
                        !(await confirm(
                          '应用写入配置？',
                          `将「${active.name}」写入 ${filename(active.appType)}。`,
                          '应用写入',
                        ))
                      )
                        return;
                      const a = await api.applyPrompt(active.id);
                      r.reload();
                      notify('系统提示词已应用', systemNote(a));
                    })
                  }
                >
                  应用写入配置
                </Btn>
                {active && (
                  <IconBtn
                    icon={Trash2}
                    label="删除预设"
                    disabled={!!pending}
                    onClick={() =>
                      void run('delete', async () => {
                        if (!(await confirm('删除预设？', active.name, '删除'))) return;
                        await api.deletePrompt(active.id);
                        setDirty(false);
                        setId(null);
                        r.reload();
                        notify('预设已删除');
                      })
                    }
                  />
                )}
                {dirty && <small className="amber">未保存</small>}
              </div>
            </div>
          ) : (
            <Empty icon={FileCode2} title="暂无提示词预设" />
          )}
        </div>
      )}
    </>
  );
}
