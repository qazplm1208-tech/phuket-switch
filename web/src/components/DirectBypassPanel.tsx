import { useState } from 'react';
import { Activity, RefreshCw, Save } from 'lucide-react';
import { PHUKET_BASE_URL } from '@shared/constants';
import type { DirectBypassProbeResult, DirectBypassStatus, UpdateDirectBypassRequest } from '@shared/types';
import { api } from '../api/client';
import { ms } from '../lib/display';
import { useAction } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { Badge, Btn, Choices, Field, Notice, Section, Skeleton, Toggle } from './ui';

const modes = [
  ['physical-nic', '物理网卡直连（绕过代理 + TUN）'],
  ['skip-proxy', '仅跳过系统代理'],
] as const;

export function DirectBypassBadge({ status }: { status: DirectBypassStatus }) {
  if (!status.config.enabled) return <Badge dot>未启用</Badge>;
  if (status.config.mode === 'skip-proxy') return <Badge dot tone="good">绕过系统代理</Badge>;
  return status.bridgeRunning ? <Badge dot tone="good">物理网卡直连中</Badge> : <Badge dot tone="amber">已启用 · 待连接</Badge>;
}

export default function DirectBypassPanel() {
  const r = useResource('direct-bypass', api.directBypass), status = r.data, config = status?.config;
  const { pending, run } = useAction(), busy = r.loading || !!pending;
  // A null draft follows the saved value. Refreshes and unrelated PUTs leave an edit in progress alone.
  const [nicDraft, setNic] = useState<string | null>(null), [dnsDraft, setDns] = useState<string | null>(null);
  const [url, setUrl] = useState(''), [result, setResult] = useState<DirectBypassProbeResult | null>(null);
  const nic = nicDraft ?? config?.interfaceName ?? '', dns = dnsDraft ?? config?.dnsServers.join(', ') ?? '';
  const missing = [...new Set([config?.interfaceName, nic])].filter(name => name && !status?.adapters.some(a => a.name === name));
  const selected = status?.selected;

  function save(patch: UpdateDirectBypassRequest) {
    void run('save', async () => {
      r.replace(await api.updateDirectBypass(patch));
      if (patch.interfaceName !== undefined) setNic(null);
      if (patch.dnsServers !== undefined) setDns(null);
      setResult(null);
    });
  }
  function probe() {
    void run('probe', async () => {
      setResult(null);
      const probeResult = await api.probeDirectBypass({ url: url.trim() || undefined });
      setResult(probeResult);
      // A probe can restart a previously unavailable physical bridge.
      if (config?.enabled && config.mode === 'physical-nic') r.reload();
    });
  }

  return <section className="stack direct-bypass" aria-label="网络直连（绕过代理）">
    <Section title="网络直连（绕过代理）" actions={<>
      {status && <span role="status"><DirectBypassBadge status={status} /></span>}
      <Btn icon={RefreshCw} busy={r.loading} disabled={!!pending} onClick={r.reload}>刷新网卡</Btn>
    </>} />
    {r.error && <Notice tone="bad" retry={r.reload}>{r.error}</Notice>}
    {!status && r.loading && <Skeleton />}
    {status && config && <>
      {status.error && <Notice tone="bad">{status.error}{config.mode === 'physical-nic'
        ? ' 可改用「仅跳过系统代理」，无需 Python 或物理网卡。' : ' 网卡检测不影响「仅跳过系统代理」模式。'}</Notice>}
      <div className="grouped-list">
        <div className="setting-row">
          <div className="grow"><b>启用绕过代理直连</b><small>开启后，PhuketAI 请求、本地代理转发与测速可绕过系统代理直接发送。</small></div>
          <Toggle label="启用绕过代理直连" on={config.enabled} disabled={busy} change={() => save({ enabled: !config.enabled })} />
        </div>
        <div className="setting-row">
          <b className="grow">直连模式</b>
          <Choices label="直连模式" items={modes} value={config.mode} disabled={busy} change={mode => { if (mode !== config.mode) save({ mode }); }} />
        </div>
        {config.mode === 'physical-nic' && <>
          <form className="setting-row direct-fields" onSubmit={e => {
            e.preventDefault();
            save({ interfaceName: nic.trim(), dnsServers: dns.trim().split(/[,，\s]+/).filter(Boolean) });
          }}>
            <Field label="物理网卡"><select value={nic} disabled={busy} onChange={e => setNic(e.target.value)}>
              <option value="">自动选择（优先 IPv4、按跃点数）</option>
              {missing.map(name => <option key={name} value={name}>{name}（未检测到）</option>)}
              {status.adapters.map(a => <option key={a.index ?? a.name} value={a.name}>
                {[a.name, a.ipv4 || a.ipv6, a.metric != null && `跃点数 ${a.metric}`].filter(Boolean).join(' · ')}
              </option>)}
            </select></Field>
            <Field label="DNS 服务器（可选）"><input value={dns} disabled={busy} onChange={e => setDns(e.target.value)}
              placeholder="留空自动使用物理网卡 DNS，例如 223.5.5.5, 119.29.29.29" /></Field>
            <Btn type="submit" icon={Save} disabled={busy || (nicDraft === null && dnsDraft === null)}>保存网卡与 DNS</Btn>
          </form>
          {selected && <div className="setting-row">
            <div className="grow"><b>{status.bridgeRunning ? '当前网卡' : '候选网卡'}：{selected.name}</b>
              <small>IPv4：{selected.ipv4 || '—'} · IPv6：{selected.ipv6 || '—'}</small>
              <small>网关：{selected.gateway || '—'} · DNS：{selected.dnsServers.join(', ') || '—'}</small>
            </div>
            <Badge tone={status.bridgeRunning ? 'good' : 'muted'}>{status.bridgeRunning ? '直连桥运行中' : '直连桥未运行'}</Badge>
          </div>}
        </>}
        <div className="setting-row">
          <div className="grow"><b>同步用于子代理（Astra MCP）</b><small>开启后，前往「子代理」页重新应用即可为子代理同步直连参数。</small></div>
          <Toggle label="同步用于子代理（Astra MCP）" on={config.applyToSubagent} disabled={busy} change={() => save({ applyToSubagent: !config.applyToSubagent })} />
        </div>
        <form className="setting-row direct-fields" onSubmit={e => { e.preventDefault(); probe(); }}>
          <Field label="测试地址（可选）"><input value={url} disabled={busy} placeholder={PHUKET_BASE_URL} onChange={e => { setUrl(e.target.value); setResult(null); }} /></Field>
          <Btn icon={Activity} type="submit" busy={pending === 'probe'} disabled={busy}>测试直连</Btn>
        </form>
        {result && <div className="setting-row" role="status">
          <Badge tone={result.ok ? 'good' : 'bad'}>{result.ok ? '可达' : '测试失败'}</Badge>
          <div className="grow"><b>{result.statusCode != null ? `HTTP ${result.statusCode}` : '无 HTTP 响应'} · {ms(result.latencyMs)}</b>
            <small>{result.bypassUsed ? '已使用直连' : '未使用直连'}{result.route && ` · ${result.route.name}`}{result.error && ` · ${result.error}`}</small>
          </div>
        </div>}
      </div>
    </>}
  </section>;
}
