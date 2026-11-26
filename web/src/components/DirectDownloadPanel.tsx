import { useState } from 'react';
import { Activity, Copy, FileDiff, ListChecks, RefreshCw, Save, Trash2 } from 'lucide-react';
import { PHUKET_BASE_URL } from '@shared/constants';
import { directDownloadTargets, type ApplyDirectDownloadRequest, type DirectDownloadDiffPreview,
  type DirectDownloadStatus, type DirectDownloadTestResult } from '@shared/types';
import { api } from '../api/client';
import { ms, num, systemNote } from '../lib/display';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { DiffPane } from './DiffPreviewModal';
import { Badge, Btn, Choices, Disclosure, Field, IconBtn, Modal, Notice, Section, Skeleton, Toggle } from './ui';

const modes = [
  ['follow-bypass', '跟随网络直连设置'],
  ['physical-nic', '物理网卡直连（绕过代理 + TUN）'],
  ['skip-proxy', '仅跳过系统代理'],
] as const;

function savedForm({ config, liveTargets }: DirectDownloadStatus) {
  return {
    mode: config.mode, interfaceName: config.interfaceName, dns: config.dnsServers.join(', '),
    connections: String(config.connections), retries: String(config.retries), maxRate: config.maxRate,
    resume: config.resume, enableTorrent: config.enableTorrent, customInstructions: config.customInstructions ?? '',
    targets: directDownloadTargets.filter(id => config.targets[id] || liveTargets[id].injected),
  };
}
type Form = ReturnType<typeof savedForm>;
function requestFor(form: Form): ApplyDirectDownloadRequest {
  const physical = form.mode === 'physical-nic';
  return {
    mode: form.mode, interfaceName: physical ? form.interfaceName : '',
    dnsServers: physical ? form.dns.split(/[,，\s]+/).filter(Boolean) : [],
    connections: Number(form.connections), retries: Number(form.retries), maxRate: form.maxRate.trim(),
    resume: form.resume, enableTorrent: form.enableTorrent, customInstructions: form.customInstructions.trim(), targets: form.targets,
  };
}
const inRange = (s: string, min: number, max: number) => s.trim() !== '' && Number.isInteger(+s) && +s >= min && +s <= max;
const capabilityLabels: ReadonlyArray<readonly [string, string]> = [
  ['resume', '断点续传'], ['parallel-chunks', '并行分片'], ['batch', '批量并发'], ['torrent', '种子/磁力'],
  ['dht', 'DHT'], ['checksum', '校验'], ['rate-limit', '限速'], ['extract', '安全解压'],
];
function fileSize(bytes?: number | null) {
  if (bytes == null) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${num(n)} ${units[i]}`;
}
function TestReport({ result }: { result: DirectDownloadTestResult }) {
  const { probe } = result;
  return <div className="subagent-result" role="status">
    <div className="tags">
      <Badge dot tone={result.ok ? 'good' : 'bad'}>{result.ok ? probe ? '探测成功' : '自检通过' : '检查失败'}</Badge>
      <span>脚本 {result.scriptVersion ?? '未知'} · Python {result.pythonVersion ?? '未知'} · {ms(result.latencyMs)}</span>
    </div>
    {!!result.capabilities.length && <div className="tags" aria-label="脚本能力">
      {capabilityLabels.filter(([id]) => result.capabilities.includes(id)).map(([id, name]) => <Badge key={id}>{name}</Badge>)}
    </div>}
    {result.error && <Notice tone="bad">{result.error}</Notice>}
    {probe && <>
      <div><small>最终 URL</small><div><code>{probe.finalUrl ?? probe.url}</code></div></div>
      <dl><dt>文件名</dt><dd>{probe.filename ?? '未知'}</dd><dt>大小</dt><dd>{fileSize(probe.totalSize)}</dd>
        <dt>实际路由</dt><dd>{probe.route?.name ?? '未知'}{probe.route?.systemRoute && '（系统路由）'}</dd>
        <dt>断点续传</dt><dd><Badge tone={probe.acceptRanges ? 'good' : 'muted'}>{probe.acceptRanges == null ? '未知' : probe.acceptRanges ? '支持续传' : '未报告支持'}</Badge></dd>
      </dl>
    </>}
  </div>;
}

const examples = String.raw`$dl = Join-Path $HOME '.phuket-switch\direct-download\direct_download.py'
# 无需绑定物理网卡时可改用 --system-route
# HTTP：并行下载，中断后重跑同一命令即可续传
python -u $dl --physical-nic -c 4 -d downloads 'https://example.invalid/model.bin'
# 批量并发：urls.txt 每行一个地址
python -u $dl --physical-nic -i urls.txt -j 3 -d downloads
# 本地种子或磁力链接：替换为实际文件或链接
python -u $dl --physical-nic -d downloads 'example.torrent'
python -u $dl --physical-nic -d downloads 'magnet:?xt=urn:btih:<info-hash>'
# 使用发布方提供的 SHA-256 校验，通过后解压
python -u $dl --physical-nic --sha256 '<64位十六进制摘要>' --extract -d downloads 'https://example.invalid/archive.zip'`;

export default function DirectDownloadPanel() {
  const r = useResource('direct-download', api.directDownload), status = r.data;
  const { notify, confirm } = useFeedback(), { pending, run } = useAction();
  const [draft, setDraft] = useState<Form | null>(null), form = draft ?? (status && savedForm(status));
  const physical = form?.mode === 'physical-nic';
  const network = useStudio().directBypassResource;
  const [diff, setDiff] = useState<DirectDownloadDiffPreview | null>(null), [ruleDraft, setRuleDraft] = useState<string | null>(null);
  const [probeUrl, setProbeUrl] = useState(''), [result, setResult] = useState<DirectDownloadTestResult | null>(null);
  if (!status || !form) return r.error ? <Notice retry={r.reload}>{r.error}</Notice> : <Skeleton rows={3} />;

  const { python, liveTargets } = status, busy = !!pending || r.loading;
  const adapters = network.data?.adapters ?? [];
  const missing = [...new Set([status.config.interfaceName, form.interfaceName, network.data?.config.interfaceName])]
    .filter((name): name is string => !!name && !adapters.some(a => a.name === name));
  const injected = directDownloadTargets.filter(id => liveTargets[id].injected);
  const selectedInjected = injected.filter(id => form.targets.includes(id));
  const numericIssue = !inRange(form.connections, 1, 16) ? '并行连接数须为 1 至 16 的整数。'
    : !inRange(form.retries, 0, 20) ? '重试次数须为 0 至 20 的整数。' : '';
  const canPreview = !busy && !numericIssue && form.targets.length > 0;
  const canApply = canPreview && python.meetsMinimum;
  const body = requestFor(form), markdown = ruleDraft ?? status.previewMarkdown;
  const change = (patch: Partial<Form>) => { setDraft({ ...form, ...patch }); setRuleDraft(null); };
  const refresh = () => { r.reload(); if (physical) network.reload(); setRuleDraft(null); setResult(null); };
  const acceptStatus = (next: DirectDownloadStatus) => {
    r.replace(next); setDraft(null); setDiff(null); setRuleDraft(null); setResult(null);
  };
  const preview = () => void run('preview', async () => {
    const out = await api.previewDirectDownload(body);
    setRuleDraft(out.previewMarkdown); setDiff(out);
  });
  const apply = () => void run('apply', async () => {
    const out = await api.applyDirectDownload(body);
    acceptStatus(out.status); notify('已写入脚本与规则', systemNote(out.system));
  });
  const remove = (targets: Form['targets'], action: 'remove' | 'remove-all') => void run(action, async () => {
    const names = targets.map(id => liveTargets[id].name).join('、');
    if (!await confirm('移除下载器规则？', `仅从 ${names} 移除下载器标记区块，保留其他规则。没有客户端再使用时会删除共享脚本，不影响已下载的文件。`, '确认移除')) return;
    const out = await api.removeDirectDownload({ targets, removeScripts: true });
    acceptStatus(out.status); notify(out.status.scriptInstalled ? '已移除下载器规则，保留共享脚本' : '已移除下载器规则与脚本', systemNote(out.system));
  });
  const test = () => void run('test', async () => {
    setResult(null); setResult(await api.testDirectDownload({ url: probeUrl.trim() || undefined }));
  });

  return <section className="stack direct-download" aria-label="AI 直连下载">
    <Section title="AI 直连下载" actions={<>
      <Badge dot tone={status.scriptInstalled ? 'good' : 'muted'}>{status.scriptInstalled ? '已部署脚本' : '未部署'}</Badge>
      <Badge tone={python.meetsMinimum ? 'good' : 'amber'}>Python {python.version ?? '未检测到'} · {python.meetsMinimum ? '满足 3.10+' : '需要 3.10+'}</Badge>
      <IconBtn icon={RefreshCw} label="刷新下载器状态" disabled={busy} onClick={refresh} />
    </>} />
    {r.error && <Notice retry={refresh}>{r.error}</Notice>}
    {!python.meetsMinimum && <Notice>部署与自检需要 Python 3.10 或更高版本；仍可预览规则和文件差异。</Notice>}
    <div className="grouped-list">
      {([['Python 脚本', status.scriptPath], ['Windows 启动器', status.cmdPath]] as const).map(([label, path]) =>
        <div className="setting-row" key={label}><div className="grow"><b>{label}</b><small><code>{path}</code></small></div>
          <IconBtn icon={Copy} label={`复制${label}路径`} onClick={() => void copyText(path, notify)} /></div>)}
    </div>

    <Section title="下载默认值" />
    <Choices label="下载直连模式" items={modes} value={form.mode} disabled={busy} change={mode => change({ mode })} />
    <small>{form.mode === 'follow-bypass' ? '写入时使用网络直连设置；网络直连未开启时，仅跳过系统代理。网络设置变更后需重新写入规则。'
      : physical ? '绑定物理网卡；网卡不可用时报告错误。' : '跳过系统代理，但仍使用系统路由，不保证绕过 VPN / TUN。'}</small>
    {physical && <>
      {network.error && <Notice retry={network.reload}>{network.error}</Notice>}
      {network.data?.error && <Notice retry={network.reload}>{network.data.error}</Notice>}
      <div className="form-grid">
        <Field label="物理网卡"><select value={form.interfaceName} disabled={busy || network.loading} onChange={e => change({ interfaceName: e.target.value })}>
          <option value="">自动选择（优先 IPv4、按跃点数）</option>
          {missing.map(name => <option key={name} value={name}>{name}（未检测到）</option>)}
          {adapters.map(a => <option key={a.index ?? a.name} value={a.name}>{[a.name, a.ipv4 || a.ipv6].filter(Boolean).join(' · ')}</option>)}
        </select></Field>
        <Field label="自定义 DNS（可选）"><input value={form.dns} disabled={busy} placeholder="留空使用网卡 DNS，多个地址用逗号分隔" onChange={e => change({ dns: e.target.value })} /></Field>
      </div>
    </>}
    <div className="form-grid">
      <Field label="并行连接数（1–16）"><input type="number" min={1} max={16} value={form.connections} disabled={busy} onChange={e => change({ connections: e.target.value })} /></Field>
      <Field label="重试次数（0–20）"><input type="number" min={0} max={20} value={form.retries} disabled={busy} onChange={e => change({ retries: e.target.value })} /></Field>
    </div>
    {numericIssue && <Notice>{numericIssue}</Notice>}
    <Field label="总限速（字节/秒）"><input value={form.maxRate} maxLength={32} disabled={busy} placeholder="留空不限速，如 10M / 500K" onChange={e => change({ maxRate: e.target.value })} /></Field>
    <div className="grouped-list">
      {([['resume', '启用断点续传'], ['enableTorrent', '启用种子 / 磁力下载支持（.torrent / magnet:）']] as const).map(([key, label]) =>
        <div className="setting-row" key={key}><b className="grow">{label}</b><Toggle label={label} on={form[key]} disabled={busy} change={() => change({ [key]: !form[key] })} /></div>)}
    </div>
    <Field label="补充规则（可选）"><textarea rows={2} maxLength={2000} value={form.customInstructions} disabled={busy} onChange={e => change({ customInstructions: e.target.value })} /></Field>

    <Section title="写入目标" count={form.targets.length} actions={<Btn icon={ListChecks} disabled={busy}
      onClick={() => change({ targets: directDownloadTargets.filter(id => liveTargets[id].detected) })}>选择已检测客户端</Btn>} />
    <div className="grouped-list" aria-label="下载规则目标">
      {directDownloadTargets.map(id => {
        const target = liveTargets[id];
        return <label className="setting-row" key={id}>
          <input type="checkbox" aria-label={`选择 ${target.name}`} checked={form.targets.includes(id)} disabled={busy}
            onChange={e => change({ targets: e.target.checked ? [...form.targets, id] : form.targets.filter(v => v !== id) })} />
          <span className="grow"><b>{target.name}</b><small><code>{target.path}</code></small></span>
          <span className="tags"><Badge>{target.detected ? '已检测到' : '未检测到'}</Badge><Badge tone={target.injected ? 'good' : 'muted'}>{target.injected ? '已注入' : '未注入'}</Badge></span>
        </label>;
      })}
    </div>
    <small>仅更新所选客户端的下载规则；未勾选的已有规则保持不变。</small>
    <div className="actions">
      <Btn icon={FileDiff} disabled={!canPreview} busy={pending === 'preview'} onClick={preview}>预览变更</Btn>
      <Btn kind="primary" icon={Save} disabled={!canApply} busy={pending === 'apply'} onClick={apply}>写入脚本与规则</Btn>
      <Btn icon={Trash2} disabled={busy || !selectedInjected.length} busy={pending === 'remove'} onClick={() => remove(selectedInjected, 'remove')}>移除所选</Btn>
      {!!injected.length && <Btn kind="ghost" className="danger-hover" disabled={busy} busy={pending === 'remove-all'} onClick={() => remove(injected, 'remove-all')}>移除全部</Btn>}
    </div>
    <Disclosure title="AI 规则预览（可一键复制给 Cursor / Claude Desktop 等工具）">
      <div className="spread"><small>{ruleDraft ? '当前草稿' : draft ? '已保存的默认值；预览变更后显示当前草稿。' : '当前保存的默认值'}</small>
        <Btn icon={Copy} onClick={() => void copyText(markdown, notify)}>复制 AI 规则</Btn></div>
      <pre className="skill-preview" tabIndex={0}>{markdown}</pre>
    </Disclosure>
    <Disclosure title="快捷命令示例"><small>PowerShell · 示例绑定 Windows 物理网卡。</small><pre className="skill-preview" tabIndex={0}>{examples}</pre></Disclosure>

    <Section title="自检与探测" />
    <form className="stack" onSubmit={e => { e.preventDefault(); test(); }}>
      <Field label="探测地址（可选）" hint="留空仅运行本地自检；填写 HTTP(S) 地址后，按已保存的配置探测文件信息，不保存文件。">
        <input value={probeUrl} maxLength={4096} placeholder={PHUKET_BASE_URL} disabled={busy} onChange={e => { setProbeUrl(e.target.value); setResult(null); }} />
      </Field>
      <div className="actions"><Btn type="submit" icon={Activity} busy={pending === 'test'} disabled={busy}>自检并探测</Btn></div>
    </form>
    {result && <TestReport result={result} />}
    {diff && <Modal wide title="下载脚本与规则变更" busy={!!pending} close={() => setDiff(null)}>
      <div className="stack download-diff"><div className="spread"><b>{diff.files.length} 个文件</b><Badge>只读预览</Badge></div>
        {diff.warnings.map((warning, i) => <Notice key={i}>{warning}</Notice>)}
        {diff.files.map(file => <section className="diff-file" key={file.path}>
          <h3><code>{file.path}</code></h3><div className="diff-grid"><DiffPane text={file.before} other={file.after} /><DiffPane after text={file.after} other={file.before} /></div>
        </section>)}
        <div className="modal-foot"><Btn disabled={busy} onClick={() => setDiff(null)}>关闭预览</Btn>
          <Btn kind="primary" icon={Save} disabled={!canApply} busy={pending === 'apply'} onClick={apply}>确认并写入</Btn></div>
      </div>
    </Modal>}
  </section>;
}
