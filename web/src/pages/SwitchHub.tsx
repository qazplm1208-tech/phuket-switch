import { useState } from 'react';
import {
  Check,
  Clock3,
  FileDiff,
  FolderInput,
  Gauge,
  KeyRound,
  Layers2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ProviderView } from '@shared/types';
import { isUltraFastGroup } from '@shared/constants';
import { api } from '../api/client';
import { appName, hasCliConfig, isClaude, ms, num, protocolName, systemNote, time } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Empty, IconBtn, Modal, Notice, Skeleton } from '../components/ui';
import FastModeBar from '../components/FastModeBar';
import DiffPreviewModal from '../components/DiffPreviewModal';
import ProviderFormModal from '../components/ProviderFormModal';

function ProviderCard({ p }: { p: ProviderView }) {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const [dialog, setDialog] = useState<'edit' | 'diff' | 'activate' | null>(null);
  const writable = hasCliConfig(p.appType),
    [write, setWrite] = useState(writable);
  const syncHint = p.appType === 'gemini' ? '同步 ~/.gemini/.env 和 ~/.gemini/settings.json。'
    : p.appType === 'antigravity' ? '同步 ~/.gemini/antigravity-cli/settings.json。在 Windows 上还会更新用户环境变量 GEMINI_API_KEY 和 GOOGLE_GEMINI_BASE_URL，请重新打开终端运行 agy。'
    : p.appType === 'claude-desktop' ? '写入 configLibrary 后，请重启 Claude Desktop。' : '';
  const activate = (apply: boolean) =>
    void run('switch', async () => {
      const r = await api.activateProvider(p.id, { applyToSystem: apply });
      s.refreshProviders();
      setDialog(null);
      const note = apply ? [systemNote(r.system), syncHint].filter(Boolean).join(' · ') : p.name;
      notify(r.system.applied ? '已同步写入客户端' : '已启用供应商', note);
    });
  const mappings = p.claudeModelMap;
  const models = (['opus', 'sonnet', 'haiku', 'defaultModel'] as const).filter(
    (k) =>
      mappings?.[k] &&
      (k !== 'defaultModel' || !mappings.sonnet || mappings.defaultModel !== mappings.sonnet),
  );
  const tone = p.lastTestOk === false ? 'bad' : p.isCurrent || p.lastTestOk === true ? 'good' : 'idle';
  return (
    <article className={'provider card ' + (p.isCurrent ? 'current' : '')}>
      <div className="provider-top">
        <div className="provider-title">
          <i className={`dot ${tone}`} title={p.lastTestOk === false ? '上次测速异常' : undefined} />
          <h3 title={p.name}>{p.name}</h3>
          {p.isCurrent && <Badge tone="good">当前使用</Badge>}
          {isUltraFastGroup(p) && <Badge tone="amber">UltraFast</Badge>}
          {p.id === s.fast.ultraFastProviderId && <Badge tone="blue">UltraFast 通道</Badge>}
        </div>
        <div className="provider-actions">
          {p.isCurrent ? (
            <>
              <span className="using">
                <Check size={13} />
                使用中
              </span>
              {writable && (
                <Btn
                  disabled={!!pending}
                  onClick={() => {
                    setWrite(true);
                    setDialog('activate');
                  }}
                >
                  同步写入
                </Btn>
              )}
            </>
          ) : (
            <Btn
              className="activate"
              disabled={!!pending}
              onClick={() => (writable ? setDialog('activate') : activate(false))}
            >
              切换启用
            </Btn>
          )}
          <span className="separator" />
          <Btn
            kind="ghost"
            icon={Gauge}
            busy={pending === 'test'}
            disabled={!!pending}
            onClick={() =>
              void run('test', async () => {
                const t = await api.testProvider(p.id);
                s.refreshProviders();
                notify(t.ok ? '测速完成' : '测速失败', t.error || `${p.name} · ${ms(t.latencyMs)}`, !t.ok);
              })
            }
          >
            测速
          </Btn>
          <Btn kind="ghost" icon={FileDiff} onClick={() => setDialog('diff')}>
            Diff
          </Btn>
          <IconBtn label="编辑" icon={Pencil} onClick={() => setDialog('edit')} />
          <IconBtn
            className="danger-hover"
            label="删除"
            icon={Trash2}
            disabled={!!pending}
            onClick={() =>
              void run('delete', async () => {
                if (
                  !(await confirm(
                    '删除供应商？',
                    `将移除本地配置「${p.name}」及指向它的路由。远端密钥不会被删除。`,
                    '删除',
                  ))
                )
                  return;
                await api.deleteProvider(p.id);
                if (p.id === s.fast.ultraFastProviderId) s.fastResource.reload();
                s.refreshProviders();
                notify('已删除供应商');
              })
            }
          />
        </div>
      </div>
      <div className="metadata">
        <span>{protocolName(p.protocol)}</span>
        {p.phuketGroupName && (
          <span>
            {p.phuketGroupName}
            {p.rateMultiplier != null && ` · ${num(p.rateMultiplier)}×`}
          </span>
        )}
        {p.model && <code title={p.model}>{p.model}</code>}
        <code>
          <KeyRound size={11} />
          {p.maskedKey || '••••••••'}
        </code>
        {p.lastLatencyMs != null && (
          <code title={time(p.lastTestedAt, true)} className={p.lastTestOk === false ? 'bad' : ''}>
            <Clock3 size={11} />
            {ms(p.lastLatencyMs)}
          </code>
        )}
      </div>
      {models.length > 0 && (
        <div className="model-summary">
          {models.map((k) => (
            <span key={k}>
              {k === 'defaultModel' ? '默认' : k[0].toUpperCase() + k.slice(1)}: <code>{mappings![k]}</code>
            </span>
          ))}
        </div>
      )}
      {dialog === 'edit' && (
        <ProviderFormModal provider={p} initialApp={p.appType} close={() => setDialog(null)} />
      )}
      {dialog === 'diff' && <DiffPreviewModal provider={p} close={() => setDialog(null)} />}
      {dialog === 'activate' && (
        <Modal
          title={p.isCurrent ? '同步写入客户端' : '切换供应商'}
          busy={!!pending}
          close={() => setDialog(null)}
        >
          <div className="form-stack">
            <p className="dialog-copy">
              {appName[p.appType]} 将使用「{p.name}」。
            </p>
            {!p.isCurrent && (
              <label className="check">
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
                同时写入本地配置
              </label>
            )}
            {write && (
              <p className="muted">
                {s.prefs.data?.backupBeforeSwitch
                  ? '写入前会备份现有配置。'
                  : '自动备份未开启，写入可能覆盖现有配置。'}
                {syncHint}
              </p>
            )}
            <div className="modal-foot">
              <Btn disabled={!!pending} onClick={() => setDialog(null)}>
                取消
              </Btn>
              <Btn kind="primary" busy={!!pending} onClick={() => activate(write)}>
                {p.isCurrent ? '同步写入' : '切换启用'}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}
export default function SwitchHub() {
  const s = useStudio(),
    [add, setAdd] = useState(false),
    a = s.client;
  const live = s.overview.data?.liveCliStates.find((v) => v.appType === a);
  const items = (s.providers.data ?? [])
    .filter((p) => p.appType === a)
    .sort((x, y) => Number(y.isCurrent) - Number(x.isCurrent) || x.priority - y.priority);
  const count = s.providers.data ? items.length : s.overview.data?.providerCounts[a];
  const status = !live
    ? '读取本地配置中'
    : live.warnings.length
      ? '配置待检查'
      : a === 'gpt-native'
        ? live.detected
          ? '本地路由可用'
          : '未启用路由'
        : live.detected
          ? '已检测本地配置'
          : '未检测到配置';
  return (
    <div className="hub">
      <div className="hub-bar">
        <div className="inline">
          <h1>供应商</h1>
          <span
            className="live-state"
            title={[...(live?.configPaths ?? []), ...(live?.warnings ?? [])].join('\n')}
          >
            <i className={'dot ' + (live?.warnings.length ? 'amber' : live?.detected ? 'good' : 'idle')} />
            {appName[a]} · {s.overview.error && !live ? '状态未知' : status}
          </span>
          <span className="hub-count">{num(count)} 项</span>
        </div>
        <div className="actions">
          <Btn icon={Layers2} kind="ghost" onClick={() => s.navigate('/proxy', 'routes')}>
            跨协议路由
          </Btn>
          <Btn icon={FolderInput} onClick={() => s.navigate('/groups')}>
            从分组添加
          </Btn>
          <Btn icon={Plus} kind="primary" onClick={() => setAdd(true)}>
            添加配置
          </Btn>
        </div>
      </div>
      {!!live?.warnings.length && <Notice tone="amber">{live.warnings.join(' ')}</Notice>}
      {a === 'codex' && <FastModeBar />}
      {s.providers.error && <Notice retry={s.providers.reload}>{s.providers.error}</Notice>}
      {s.overview.error && !s.providers.error && (
        <Notice retry={s.overview.reload}>{s.overview.error}</Notice>
      )}
      {s.providers.loading && !s.providers.data ? (
        <Skeleton />
      ) : items.length ? (
        <div className="provider-list">
          {items.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        !s.providers.error && (
          <Empty
            icon={Layers2}
            title={`还没有 ${appName[a]} 供应商`}
            action={
              <div className="actions">
                <Btn onClick={() => setAdd(true)} icon={Plus}>
                  添加配置
                </Btn>
                <Btn kind="ghost" onClick={() => s.navigate('/extensions', 'import')}>
                  从 CC-Switch 导入
                </Btn>
              </div>
            }
          />
        )
      )}
      {add && (
        <ProviderFormModal
          initialApp={a}
          close={() => setAdd(false)}
          saved={(p) => s.selectClient(p.appType)}
        />
      )}
    </div>
  );
}
