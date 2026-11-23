import { useState } from 'react';
import {
  ArchiveRestore,
  BookOpen,
  ChevronRight,
  Database,
  Download,
  FolderSearch,
  RefreshCw,
} from 'lucide-react';
import type { AppSettings, CcSwitchImportResult } from '@shared/types';
import { PHUKET_BASE_URL } from '@shared/constants';
import { api } from '../api/client';
import { appName, systemNote, time } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { SearchInput } from '../components/LoginGate';
import McpView from '../components/McpView';
import PromptView from '../components/PromptView';
import SoftwareUpdates from '../components/SoftwareUpdates';
import ImagePromptPanel from '../components/ImagePromptPanel';
import { Badge, Btn, Choices, Empty, IconBtn, Notice, Section, Skeleton, Toggle } from '../components/ui';

const tabs = [
  ['mcp', 'MCP 服务器'],
  ['prompts', '系统提示词'],
  ['image-prompt', '生图适配'],
  ['skills', 'Skills'],
  ['backups', '配置备份'],
  ['import', 'CC-Switch 导入'],
  ['preferences', '偏好设置'],
] as const;
function Skills() {
  const r = useResource('skills', api.skills),
    [q, setQ] = useState('');
  const rows = (r.data ?? []).filter((v) =>
    `${v.name} ${v.description}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <>
      <Section
        title="本地技能"
        count={rows.length}
        actions={<SearchInput value={q} label="搜索技能" change={setQ} />}
      />
      {r.error ? (
        <Notice retry={r.reload}>{r.error}</Notice>
      ) : r.loading && !r.data ? (
        <Skeleton />
      ) : rows.length ? (
        <div className="grouped-list">
          {rows.map((v) => (
            <details className="skill" key={v.id}>
              <summary>
                <div className="spread">
                  <h3>{v.name}</h3>
                  <div className="tags">
                    {v.appTypes.map((a) => (
                      <Badge key={a}>{appName[a]}</Badge>
                    ))}
                    <ChevronRight size={14} />
                  </div>
                </div>
                <p>{v.description || '暂无描述'}</p>
              </summary>
              <pre className="skill-preview">{v.content || '没有可预览的内容。'}</pre>
            </details>
          ))}
        </div>
      ) : (
        <Empty icon={BookOpen} title={q ? '没有匹配的技能' : '尚未发现本地技能'} />
      )}
    </>
  );
}
function Import() {
  const r = useResource('cc-detect', api.detectCc),
    s = useStudio(),
    { notify } = useFeedback(),
    { pending, run } = useAction();
  const [selected, set] = useState<string[]>([]),
    [result, setResult] = useState<CcSwitchImportResult | null>(null);
  const rows = r.data?.providers ?? [],
    ids = selected.filter((id) => rows.some((v) => v.sourceId === id));
  return (
    <>
      <Section
        title="导入本地配置"
        actions={<IconBtn icon={RefreshCw} label="重新检测" onClick={r.reload} />}
      />
      <div className="source-path">
        <Database size={15} />
        <code>{r.data?.sourcePath || '~/.cc-switch/cc-switch.db'}</code>
        <Badge>只读</Badge>
      </div>
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.data?.warnings.map((w, i) => (
        <Notice key={i}>{w}</Notice>
      ))}
      {r.loading && !r.data ? (
        <Skeleton />
      ) : rows.length ? (
        <>
          <div className="grouped-list">
            <label className="setting-row">
              <input
                type="checkbox"
                checked={ids.length === rows.length}
                onChange={(e) => set(e.target.checked ? rows.map((v) => v.sourceId) : [])}
              />
              全选（{rows.length}）
            </label>
            {rows.map((p) => (
              <label key={p.sourceId} className="setting-row">
                <input
                  type="checkbox"
                  checked={ids.includes(p.sourceId)}
                  onChange={(e) =>
                    set(
                      e.target.checked ? [...selected, p.sourceId] : selected.filter((v) => v !== p.sourceId),
                    )
                  }
                />
                <b className="grow">{p.name}</b>
                <Badge>{appName[p.appType]}</Badge>
              </label>
            ))}
          </div>
          <div className="spread">
            <small>仅导入所选配置，不切换客户端。</small>
            <Btn
              kind="primary"
              icon={Download}
              busy={!!pending}
              disabled={!ids.length}
              onClick={() =>
                void run('import', async () => {
                  const out = await api.importCc({ sourceIds: ids });
                  setResult(out);
                  set([]);
                  s.refreshProviders();
                  notify('导入完成', `已导入 ${out.imported.length} 项，跳过 ${out.skipped.length} 项。`);
                })
              }
            >
              导入所选配置（{ids.length}）
            </Btn>
          </div>
        </>
      ) : (
        !r.error && (
          <Empty
            icon={FolderSearch}
            title={r.data?.detected ? '没有可导入的配置' : '未检测到 CC-Switch 数据库'}
          />
        )
      )}
      {result && (
        <div className="stack">
          {result.skipped.map((v) => (
            <p className="muted" key={v.sourceId}>
              {rows.find((p) => p.sourceId === v.sourceId)?.name || v.sourceId} ·{' '}
              {v.reason === 'Already imported.' ? '已导入' : v.reason}
            </p>
          ))}
          {result.warnings.map((w, i) => (
            <Notice key={i}>{w}</Notice>
          ))}
        </div>
      )}
    </>
  );
}
const reasons: Record<string, string> = {
  'Apply subagent': '部署子代理插件与配置',
  'Remove subagent': '移除子代理配置',
  'Apply provider configuration': '写入供应商配置',
  'Enable proxy takeover': '启用代理接管',
  'Apply prompt preset': '应用系统提示词',
  'Apply image generation prompt': '写入生图系统提示词',
  'Remove image generation prompt': '移除生图系统提示词',
  'Save MCP server': '保存 MCP 服务器',
  'Remove MCP server': '移除 MCP 服务器',
};
function Backups() {
  const s = useStudio(), r = s.backups,
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const rows = [...(r.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <Section
        title="备份记录"
        count={r.data?.length}
        actions={<IconBtn icon={RefreshCw} label="刷新备份" onClick={r.reload} />}
      />
      {r.error ? (
        <Notice retry={r.reload}>{r.error}</Notice>
      ) : r.loading && !r.data ? (
        <Skeleton />
      ) : rows.length ? (
        <ol className="backup-list">
          {rows.map((b) => (
            <li key={b.id}>
              <i className="backup-dot" />
              <div className="grow">
                <time>{time(b.createdAt, true)}</time>
                <div className="inline">
                  <b>{reasons[b.reason] || b.reason || '配置备份'}</b>
                  <Badge>{['Apply subagent', 'Remove subagent'].includes(b.reason) ? '子代理' : appName[b.appType]}</Badge>
                </div>
                <details>
                  <summary>{b.files.length} 个文件</summary>
                  {b.files.map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </details>
              </div>
              <Btn
                icon={ArchiveRestore}
                disabled={!!pending}
                busy={pending === b.id}
                onClick={() =>
                  void run(b.id, async () => {
                    if (
                      !(await confirm(
                        '恢复此备份？',
                        `将使用 ${time(b.createdAt, true)} 的备份覆盖所列配置文件。`,
                        '恢复',
                      ))
                    )
                      return;
                    const out = await api.restore(b.id);
                    s.refreshAll();
                    r.reload();
                    notify('已恢复备份', systemNote(out));
                  })
                }
              >
                恢复
              </Btn>
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon={ArchiveRestore} title="暂无配置备份" note="写入配置时创建的备份会列在这里。" />
      )}
    </>
  );
}
function Preferences() {
  const s = useStudio(),
    { pending, run } = useAction(),
    { confirm, notify } = useFeedback();
  const save = (patch: Partial<AppSettings>) =>
    void run('save', async () => {
      await s.saveSettings(patch);
      notify('偏好设置已保存');
    });
  return (
    <>
      {s.prefs.error && <Notice retry={s.prefs.reload}>{s.prefs.error}</Notice>}
      <Section title="外观与通用设置" />
      <div className="grouped-list">
        <div className="setting-row">
          <b className="grow">外观</b>
          <Choices
            label="主题"
            items={
              [
                ['system', '默认（浅色）'],
                ['light', '浅色'],
                ['dark', '深色'],
              ] as const
            }
            value={s.preference}
            disabled={!s.prefs.data || s.themeBusy || !!pending}
            change={(theme) => save({ theme })}
          />
        </div>
        <div className="setting-row">
          <div className="grow">
            <b>切换前自动备份</b>
            <small>写入配置文件前创建本地备份。</small>
          </div>
          <Toggle
            label="切换前自动备份"
            disabled={!s.prefs.data || !!pending}
            on={!!s.prefs.data?.backupBeforeSwitch}
            change={() => save({ backupBeforeSwitch: !s.prefs.data?.backupBeforeSwitch })}
          />
        </div>
        <div className="setting-row">
          <b className="grow">默认端点</b>
          <code>{PHUKET_BASE_URL}</code>
        </div>
      </div>
      <SoftwareUpdates />
      {window.phuketDesktop?.isElectron && (
        <div className="actions end">
          <Btn
            onClick={() =>
              void run('quit', async () => {
                if (await confirm('退出 Phuket Switch？', '本地管理服务与代理将停止运行。', '退出应用'))
                  await window.phuketDesktop?.quit();
              })
            }
          >
            退出应用
          </Btn>
        </div>
      )}
    </>
  );
}
export default function ExtensionsAndSettings() {
  const s = useStudio(),
    tab = tabs.find(([v]) => v === s.tab)?.[0] ?? 'mcp';
  return (
    <div className="stack">
      <div className="tab-bar">
        <Choices
          tabs
          items={tabs}
          label="扩展与设置"
          value={tab}
          change={(v) => s.navigate('/extensions', v)}
        />
      </div>
      {tab === 'mcp' ? (
        <McpView />
      ) : tab === 'prompts' ? (
        <PromptView />
      ) : tab === 'image-prompt' ? (
        <ImagePromptPanel />
      ) : tab === 'skills' ? (
        <Skills />
      ) : tab === 'backups' ? (
        <Backups />
      ) : tab === 'import' ? (
        <Import />
      ) : (
        <Preferences />
      )}
    </div>
  );
}
