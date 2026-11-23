import { Braces, CheckCheck, Copy, ListChecks, Square, Trash2 } from 'lucide-react';
import type { SubagentDiffPreview, SubagentHarnessId as Id, SubagentHarnessState, SubagentStatus } from '@shared/types';
import { copyText, useFeedback } from '../lib/feedback';
import { harnessName, protocols, safePreview, warningText, type Draft } from '../lib/subagent';
import { DiffPane } from './DiffPreviewModal';
import { Badge, Btn, Empty, Modal, Notice, Section } from './ui';

export function HarnessPanel({ status, draft, select, snippet, remove, busy }: {
  status: SubagentStatus; draft: Draft; select: (ids: Id[]) => void; snippet: (h: SubagentHarnessState) => void; remove: (ids: Id[]) => void; busy: boolean;
}) {
  const rows = status.harnesses, detected = rows.filter(h => h.detected).map(h => h.id);
  return <section className="card padded subagent-panel" aria-label="客户端适配">
    <Section title="客户端适配" actions={<>
      <Btn kind="ghost" icon={ListChecks} disabled={busy || !detected.length} onClick={() => select(detected)}>勾选已检测</Btn>
      <Btn kind="ghost" icon={CheckCheck} disabled={busy || draft.targets.length === rows.length} onClick={() => select(rows.map(h => h.id))}>全选</Btn>
      <Btn kind="ghost" icon={Square} disabled={busy || !draft.targets.length} onClick={() => select([])}>清空</Btn>
    </>} />
    <div className="subagent-target-count">已选 <b>{draft.targets.length}</b> / {rows.length} 个客户端</div>
    {!rows.length && <Empty title="没有可用的客户端适配器" />}
    <ul className="subagent-harnesses">{rows.map(h => {
      const checked = draft.targets.includes(h.id), name = harnessName(h.id, h.name), stale = h.installed && (h.installedModel !== draft.model.trim() || h.installedProtocol !== draft.protocol);
      return <li key={h.id} className="subagent-harness">
        <label className="subagent-target-name"><input type="checkbox" aria-label={`选择 ${name}`} checked={checked} disabled={busy} onChange={() => select(checked ? draft.targets.filter(id => id !== h.id) : [...draft.targets, h.id])} /><b>{name}</b></label>
        <div className="tags subagent-harness-badges"><Badge dot tone={h.installed ? 'good' : h.detected ? 'blue' : 'muted'}>{h.installed ? '已部署' : h.detected ? '已检测' : '未检测'}</Badge>
          {stale && <Badge tone="amber">当前：{h.installedModel || '旧配置'}{h.installedProtocol !== draft.protocol && h.installedProtocol ? ` · ${protocols[h.installedProtocol][0]}` : ''}</Badge>}
          {h.rulesInstalled && <Badge tone="blue">规则已写入</Badge>}
        </div>
        <div className="actions subagent-row-actions"><Btn kind="ghost" icon={Braces} aria-label={`${name} 配置片段`} disabled={busy} onClick={() => snippet(h)}>配置片段</Btn>
          {(h.installed || h.rulesInstalled) && <Btn kind="ghost" className="danger-hover" icon={Trash2} aria-label={`移除 ${name}`} disabled={busy} onClick={() => remove([h.id])}>移除</Btn>}
        </div>
        <div className="subagent-paths"><div><span>配置</span><code>{h.mcpPath}</code></div>
          {h.rulesPath && <div><span>规则</span><code>{h.rulesPath}</code></div>}
          {!h.supportsRules && <small>{h.id === 'cursor' ? '无全局规则文件，可复制规则到项目的 .cursor/rules/phuket-subagent.mdc。' : '不支持全局规则文件，可将规则片段粘贴到项目指令。'}</small>}
          {h.notes.map((n,i) => n.startsWith('Also manages: ') ? <div key={i}><span>附加配置</span><code>{n.slice('Also manages: '.length)}</code></div> : n.includes('invalid or is not') ? <small key={i} className="amber">配置文件格式或路径异常，请检查后重试。</small> : null)}
        </div>
      </li>;
    })}</ul>
  </section>;
}
export function SnippetDialog({ h, secret, close }: { h: SubagentHarnessState; secret: string; close: () => void }) {
  const { notify } = useFeedback();
  return <Modal wide title={`${harnessName(h.id,h.name)} · 配置片段`} close={close}>
    <div className="stack"><div className="tags"><Badge tone="good">密钥已脱敏</Badge><Badge>已保存的配置</Badge></div>
      {([['MCP 配置', h.snippet], ['分工规则', h.rulesSnippet]] as const).map(([label, content]) => {
        const text = safePreview(content, secret);
        return <section key={label} className="subagent-snippet"><div className="spread"><h3>{label}</h3><Btn icon={Copy} aria-label={`复制${label}`} onClick={() => void copyText(text, notify)}>复制</Btn></div><pre tabIndex={0}>{text}</pre></section>;
      })}
    </div>
  </Modal>;
}
export function PreviewDialog({ diff, secret, busy, issue, error, apply, close }: { diff: SubagentDiffPreview; secret: string; busy: boolean; issue: string; error: string; apply: () => void; close: () => void }) {
  return <Modal wide title="预览配置变更" close={close} busy={busy}>
    <div className="stack subagent-preview"><div className="spread"><b>{diff.files.length} 个配置文件</b><Badge tone="good">密钥已脱敏</Badge></div>
      {diff.warnings.map((w,i) => <Notice key={i}>{warningText(w)}</Notice>)}
      {diff.files.map(f => { const before = f.before == null ? null : safePreview(f.before, secret), after = f.after == null ? null : safePreview(f.after, secret);
        return <section key={f.path} className="diff-file"><h3><code>{f.path}</code></h3><div className="diff-grid"><DiffPane text={before} other={after}/><DiffPane after text={after} other={before}/></div></section>;
      })}
      {!diff.files.length && <Empty title="没有待写入的文件" />}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="modal-foot subagent-modal-foot">{issue && <span className="amber">{issue}</span>}<Btn disabled={busy} onClick={close}>取消</Btn><Btn kind="primary" icon={CheckCheck} busy={busy} disabled={!!issue || !diff.files.length} onClick={apply}>确认并写入</Btn></div>
    </div>
  </Modal>;
}
