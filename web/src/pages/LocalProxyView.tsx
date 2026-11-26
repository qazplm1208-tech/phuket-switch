import { useState } from 'react';
import { ArrowRight, Cable, Copy, Laptop, Play, RefreshCw, Square, Terminal, Trash2 } from 'lucide-react';
import type { ProxySettings, ProxyStatus } from '@shared/types';
import { api } from '../api/client';
import { appName, ms, systemNote, time } from '../lib/display';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { usePoll, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { DirectBypassBadge } from '../components/DirectBypassPanel';
import RouteManager from '../components/RouteManager';
import { Badge, Btn, Choices, Empty, IconBtn, Notice, Section, Skeleton, Table, Toggle } from '../components/ui';

function SettingsForm({ proxy }: { proxy: ProxyStatus }) {
  const s = useStudio(),
    { notify } = useFeedback(),
    { pending, run } = useAction();
  const [v, set] = useState<ProxySettings>(proxy.settings),
    locked = Object.values(proxy.takeover).some(Boolean);
  return (
    <form
      className="proxy-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run('save', async () => {
          const p = await api.proxySettings(v);
          s.proxyResource.replace(p);
          notify('代理设置已保存');
        });
      }}
    >
      <label className="inline" title={locked ? '请先关闭客户端接管，再修改端口' : undefined}>
        端口
        <input
          type="number"
          min={1}
          max={65535}
          required
          disabled={locked}
          value={v.port || ''}
          onChange={(e) => set({ ...v, port: Number(e.target.value) })}
        />
      </label>
      <label className="inline">
        超时 (ms)
        <input
          type="number"
          min={1}
          max={600000}
          required
          value={v.requestTimeoutMs || ''}
          onChange={(e) => set({ ...v, requestTimeoutMs: Number(e.target.value) })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={v.failoverEnabled}
          onChange={(e) => set({ ...v, failoverEnabled: e.target.checked })}
        />
        故障转移
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={v.logRequests}
          onChange={(e) => set({ ...v, logRequests: e.target.checked })}
        />
        记录请求
      </label>
      <Btn type="submit" busy={!!pending} disabled={JSON.stringify(v) === JSON.stringify(proxy.settings)}>
        保存
      </Btn>
    </form>
  );
}
function Logs() {
  const r = useResource('logs', (sig) => api.logs({ limit: 100 }, sig)),
    [auto, setAuto] = useState(true),
    { confirm, notify } = useFeedback(),
    { pending, run } = useAction();
  usePoll(
    () => {
      if (!r.loading) r.reload();
    },
    3000,
    auto,
  );
  const items = r.data?.items ?? [];
  return (
    <section className="stack">
      <Section
        title="实时请求记录"
        count={r.data?.total}
        actions={
          <>
            <label className="check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              自动刷新
            </label>
            <IconBtn label="刷新记录" icon={RefreshCw} onClick={r.reload} />
            <IconBtn
              label="清空记录"
              icon={Trash2}
              disabled={!items.length || !!pending}
              onClick={() =>
                void run('clear', async () => {
                  if (!(await confirm('清空请求记录？', '只会清除本地记录，不影响代理运行。', '清空')))
                    return;
                  await api.clearLogs();
                  r.replace({ items: [], total: 0 });
                  notify('请求记录已清空');
                })
              }
            />
          </>
        }
      />
      {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
      {r.loading && !r.data ? (
        <Skeleton />
      ) : items.length ? (
        <Table heads={['时间', '客户端', '请求模型 → 实际模型', '状态', '总耗时']}>
          {items.map((l) => (
            <tr key={l.id}>
              <td className="mono">{time(l.createdAt)}</td>
              <td>
                {l.appType === 'claude-desktop' ? 'Claude Desktop' : l.translatedFrom === 'anthropic-messages' ? 'Claude Code' : appName[l.appType]}
                <small>{l.providerName}</small>
              </td>
              <td>
                <div className="model-route">
                  <code>{l.model || '—'}</code>
                  <ArrowRight size={12} />
                  <code>{l.effectiveModel || '—'}</code>
                  {(['priority', 'fast'].includes(l.serviceTier || '') ||
                    l.effectiveModel.endsWith('-fast') ||
                    l.fastFallback) && <Badge tone="amber">Fast</Badge>}
                  {l.translatedFrom && <span title={l.translatedFrom === 'anthropic-messages' ? 'Anthropic → Responses' : 'Responses → Anthropic'}><Badge>跨协议</Badge></span>}
                  {l.fastFallback && <Badge>已回退</Badge>}
                  {l.failoverCount > 0 && <Badge>故障转移 ×{l.failoverCount}</Badge>}
                </div>
                {l.error && <small className="bad">{l.error}</small>}
              </td>
              <td>
                <Badge tone={l.statusCode >= 400 ? 'bad' : 'good'}>{l.statusCode}</Badge>
              </td>
              <td className="mono">
                {ms(l.latencyMs)}
                {l.ttftMs != null && <small>首字 {ms(l.ttftMs)}</small>}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        !r.error && <Empty icon={Cable} title="暂无请求记录" />
      )}
    </section>
  );
}
function ProxyControls() {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction(),
    direct = s.directBypassResource,
    status = direct.data,
    p = s.proxy;
  const endpoint = p ? (p.baseUrl ?? `http://${p.settings.host}:${p.settings.port}`) : '';
  return (
    <div className="stack page-sections">
      {s.proxyResource.error && <Notice retry={s.proxyResource.reload}>{s.proxyResource.error}</Notice>}
      {p ? (
        <section className="card proxy-card">
          <div className="spread">
            <div className="actions">
              <Badge tone={p.running ? 'good' : 'muted'} dot>
                {p.running ? '运行中' : '已停止'}
              </Badge>
              <button
                className="endpoint"
                onClick={() => void copyText(endpoint, notify)}
                title="复制代理地址"
              >
                <code>{endpoint}</code>
                <Copy size={13} />
              </button>
            </div>
            <Btn
              icon={p.running ? Square : Play}
              kind={p.running ? 'secondary' : 'primary'}
              busy={pending === 'power'}
              disabled={!!pending}
              onClick={() =>
                void run('power', async () => {
                  if (
                    p.running &&
                    Object.values(p.takeover).some(Boolean) &&
                    !(await confirm('停止代理？', '已接管的客户端将暂时无法连接。', '停止'))
                  )
                    return;
                  const out = p.running ? await api.stopProxy() : await api.startProxy();
                  s.proxyResource.replace(out);
                  s.overview.reload();
                  notify(out.running ? '代理已启动' : '代理已停止');
                })
              }
            >
              {p.running ? '停止' : '启动'}
            </Btn>
          </div>
          <SettingsForm proxy={p} key={JSON.stringify(p.settings)} />
          {p.lastError && <Notice tone="bad">{p.lastError}</Notice>}
        </section>
      ) : (
        s.proxyResource.loading && <Skeleton />
      )}
      <section className="grouped-list direct-shortcut" aria-label="网络直连（绕过代理）">
        <div className="setting-row">
          <div className="grow">
            <b>网络直连（绕过代理）</b>
            <small>{!status ? (direct.loading ? '正在读取…' : '状态未知') : status.config.mode === 'skip-proxy' ? '仅跳过系统代理 · 使用系统路由' : status.bridgeRunning && status.selected
              ? `当前网卡：${status.selected.name}` : `物理网卡 · ${status.config.interfaceName || '自动选择'}`}</small>
          </div>
          {status && <span role="status"><DirectBypassBadge status={status} /></span>}
          <Toggle label="启用绕过代理直连" on={!!status?.config.enabled} disabled={!status || direct.loading || !!pending}
            change={() => status && void run('direct', async () => {
              direct.replace(await api.updateDirectBypass({ enabled: !status.config.enabled }));
            })} />
          <Btn kind="ghost" icon={ArrowRight} onClick={() => s.navigate('/extensions', 'preferences')}>详细设置</Btn>
        </div>
        {direct.error && <Notice tone="bad" retry={direct.reload}>{direct.error}</Notice>}
        {status?.config.enabled && status.config.mode === 'physical-nic' && status.error && <Notice tone="bad">{status.error}</Notice>}
      </section>
      <section className="stack">
        <Section title="客户端一键代理接管" />
        <div className="grouped-list">
          {(['claude', 'codex', 'gemini', 'antigravity', 'claude-desktop'] as const).map((a) => {
            const on = !!p?.takeover[a],
              current = s.providers.data?.some((v) => v.appType === a && v.isCurrent),
              label = a === 'claude' ? 'Claude Code' : a === 'gemini' ? 'Gemini CLI' : a === 'antigravity' ? '反重力 (Antigravity CLI)' : appName[a],
              Icon = a === 'claude-desktop' ? Laptop : Terminal;
            return (
              <div className="setting-row" key={a}>
                <Icon size={16} />
                <b className="grow">{label}</b>
                <small>
                  {!p ? '状态未知' : on ? '已接管' : !current ? '请先启用供应商' : '直连'}
                </small>
                <Toggle
                  on={on}
                  label={`接管 ${label}`}
                  disabled={!!pending || !p || (!current && !on)}
                  change={() =>
                    void run(a, async () => {
                      const out = await api.takeover({ appType: a, enable: !on });
                      s.proxyResource.replace(out.proxy);
                      s.overview.reload();
                      const restart = a === 'antigravity' ? '请重新打开终端运行 agy' : a === 'claude-desktop' ? '重启 Claude Desktop 生效' : '';
                      const note = [systemNote(out.system), !out.system.warnings?.length && restart].filter(Boolean).join(' · ');
                      notify(on ? '已恢复客户端配置' : '已接管客户端', note);
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
export default function LocalProxyView() {
  const tabs = [['', '代理与接管'], ['routes', '跨协议路由'], ['logs', '请求日志']] as const;
  const s = useStudio();
  const tab = tabs.find(([key]) => key === s.tab)?.[0] ?? '';
  return <div className="stack page-sections">
    <Choices tabs label="本地代理" items={tabs} value={tab} change={key => s.navigate('/proxy', key)} />
    {tab === 'routes' ? <RouteManager /> : tab === 'logs' ? <Logs /> : <ProxyControls />}
  </div>;
}
