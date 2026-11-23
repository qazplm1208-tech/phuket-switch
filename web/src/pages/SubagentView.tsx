import { useEffect, useRef, useState } from 'react';
import { CheckCheck, FileDiff, PlugZap, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import type { ApplySubagentRequest, ApplySubagentResult, SubagentDiffPreview, SubagentHarnessId, SubagentHarnessState, SubagentStatus, SubagentTestResult } from '@shared/types';
import { api, ApiFailure } from '../api/client';
import SubagentConfigPanel from '../components/SubagentConfigPanel';
import { HarnessPanel, PreviewDialog, SnippetDialog } from '../components/SubagentHarnessPanel';
import { Badge, Btn, IconBtn, Metric, Notice, Section, Skeleton } from '../components/ui';
import { ms, supportedGroup, systemNote, time } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { buildRequest, compactionIssue, draftFrom, endpointIssue, harnessName, maskOnly, origin, probeIssue, protocols, sourceIssue, sourceNames, testRequest, type Draft } from '../lib/subagent';

function actionError(error: unknown) {
  if (error instanceof ApiFailure) {
    if (error.message.includes('Python 3.10')) return '未找到可用的 Python 3.10+，请检查解释器路径。';
    if (error.message.includes('different origin')) return '其他客户端仍在不同地址使用此环境变量。请同时更新它们，或改用客户端密钥存储。';
    if (error.message.includes('provider origin')) return '更换基础地址的来源时，请手动填写对应密钥。';
    if (error.status === 401) return '账号会话已失效，请重新登录 PhuketAI。';
    if (error.status === 409) return '配置文件存在冲突。请检查文件格式、权限及规则标记后重试。';
    if (error.code === 'TIMEOUT') return '请求超时，请刷新状态后重试。';
    if (error.status === 400) return '配置无效，请检查模型、凭据、解释器路径及所选目标。';
    if (error.status === 404) return '所选供应商或密钥已不存在，请刷新后重新选择。';
    if (!error.status) return '无法连接本地管理服务。';
  }
  return '操作未完成，请刷新状态并检查本地配置。';
}
function ResultPanel({ r }: { r: SubagentTestResult }) {
  const handshake = !!r.serverVersion && r.toolsCount === 6;
  const upstream = r.upstreamOk === undefined ? '未探测' : r.upstreamOk === null ? '无可用凭据，已跳过' : r.upstreamOk ? '模型列表可访问' : '探测失败';
  return <section className="subagent-result" role="status" aria-label="子代理验证结果">
    <div className="spread"><div className="inline"><b>验证结果</b><Badge dot tone={handshake ? 'good' : 'bad'}>{handshake ? 'MCP 握手成功' : '握手失败'}</Badge></div><small>{time(r.testedAt)}</small></div>
    <dl><dt>握手耗时</dt><dd>{ms(r.handshakeLatencyMs ?? (r.upstreamOk === undefined ? r.latencyMs : null))}</dd><dt>服务版本</dt><dd>{r.serverVersion || '未连接'}</dd>
      <dt>实际模型</dt><dd><code>{r.effectiveModel}</code></dd><dt>实际协议</dt><dd>{protocols[r.effectiveProtocol][0]}</dd>
      <dt>上游探测</dt><dd><Badge tone={r.upstreamOk === true ? 'good' : r.upstreamOk === false ? 'bad' : 'muted'}>{upstream}</Badge></dd>
      <dt>工具数量</dt><dd>{r.toolsCount} 个</dd></dl>
    {!!r.tools.length && <div className="tags">{r.tools.map(t => <Badge key={t}><code>{t}</code></Badge>)}</div>}
    {!handshake && <Notice tone="bad">{!r.pythonExecutable || !r.pythonVersion ? '未找到解释器，请检查 Python 路径。' : 'MCP 握手未完成，请检查 Python 版本与运行环境。'}</Notice>}
    {r.upstreamOk === false && <Notice tone="bad">模型列表探测失败{r.upstreamError?.match(/HTTP (\d{3})/)?.[1] ? `（HTTP ${r.upstreamError.match(/HTTP (\d{3})/)![1]}）` : ''}，请检查基础地址、密钥和网络连接。</Notice>}
  </section>;
}
export default function SubagentView() {
  const s = useStudio(), status = useResource(`subagent:${s.identity}`, api.subagent);
  const groups = useResource(`subagent-groups:${s.identity}`, api.groups);
  const keys = useResource(s.session?.authenticated ? `subagent-keys:${s.identity}` : null, signal => api.keys({ page: 1, pageSize: 100 }, signal));
  if (!status.data) return status.error ? <Notice retry={status.reload}>无法读取子代理状态，请检查本地管理服务。</Notice> : <Skeleton rows={3} />;
  return <Editor status={status.data} replace={status.replace} stale={!!status.error} loading={status.loading} reload={status.reload} groups={groups} keys={keys} />;
}
type Rows<F extends (...args: any[]) => Promise<unknown>> = ReturnType<typeof useResource<Awaited<ReturnType<F>>>>;
function Editor({ status, replace, stale, loading, reload, groups, keys }: { status: SubagentStatus; replace: (v: SubagentStatus) => void; stale: boolean; loading: boolean; reload: () => void;
  groups: Rows<typeof api.groups>; keys: Rows<typeof api.keys> }) {
  const s = useStudio(), { notify, confirm } = useFeedback(), { pending, run } = useAction();
  const [edited, setEdited] = useState<Draft | null>(null), d = edited ?? draftFrom(status);
  const [secret, setSecret] = useState(''), [secretEpoch, bumpSecret] = useState(0);
  const [probe, setProbe] = useState(false), [result, setResult] = useState<SubagentTestResult | null>(null);
  const [preview, setPreview] = useState<{ diff: SubagentDiffPreview; request: ApplySubagentRequest } | null>(null);
  const [snippet, setSnippet] = useState<SubagentHarnessState | null>(null), [failure, setFailure] = useState('');
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const c = status.config, busy = !!pending, logged = !!s.session?.authenticated;
  const rows = (groups.data?.groups ?? []).filter(supportedGroup), p = s.providers.data?.find(v => v.id === d.providerId), g = rows.find(v => String(v.id) === d.groupId);
  const activeKeys = (keys.data?.items ?? []).filter(k => k.status === 'active' && g && (k.group_id ?? k.group?.id) === g.id);
  const installed = status.harnesses.filter(h => h.installed), removable = status.harnesses.filter(h => h.installed || h.rulesInstalled);
  const endpointError = endpointIssue(d), sourceError = sourceIssue(d, status, secret, logged, p, g, activeKeys);
  const invalid = endpointError || sourceError || compactionIssue(d) ||
    (d.customInstructions.includes('PHUKET_SWITCH_SUBAGENT_') ? '补充指令不能包含配置管理标记。' : '') || (!d.targets.length ? '请选择要部署的客户端。' : '');
  const probeHint = probeIssue(d, status, sourceError, p), pythonReady = status.python.meetsMinimum && status.python.available;
  const pythonIssue = !pythonReady && d.pythonPath.trim() === (c.pythonPath || '') ? '部署前请先配置 Python 3.10+。' : '';
  function clearSecret() { setSecret(''); bumpSecret(i => i + 1); }
  function edit(patch: Partial<Draft>) {
    const changedOrigin = patch.baseUrl !== undefined && origin(patch.baseUrl.trim()) !== origin(d.baseUrl.trim());
    if (changedOrigin || (patch.source && patch.source !== d.source) || (patch.manual && patch.manual !== d.manual)) { clearSecret(); setProbe(false); }
    setEdited({ ...d, ...patch }); setResult(null); setFailure('');
  }
  function refresh() { reload(); groups.reload(); if (logged) keys.reload(); s.providers.reload(); setResult(null); }
  function action(id: string, work: () => Promise<void>) { void run(id, async () => {
    setFailure(''); try { await work(); } catch (e) { if (alive.current) { const message = actionError(e); setFailure(message); notify('操作未完成', message, true); } }
  }); }
  function accept(out: ApplySubagentResult, deploy: boolean) {
    s.overview.reload(); s.backups.reload(); if (!alive.current) return;
    replace(out.status); if (logged) keys.reload(); setResult(null); setPreview(null); setSnippet(null);
    if (deploy) { clearSecret(); setEdited(null); }
    notify(deploy ? '已部署子代理' : '已移除子代理配置', systemNote(out.system));
  }
  function apply(request: ApplySubagentRequest) { action('apply', async () => accept(await api.applySubagent(request), true)); }
  function remove(ids: SubagentHarnessId[]) {
    const names = status.harnesses.filter(h => ids.includes(h.id)).map(h => harnessName(h.id, h.name));
    action('remove', async () => {
      if (!(await confirm('移除子代理配置？', `将移除 ${names.join('、')} 的子代理配置及分工规则，并备份受影响的文件。`, '确认移除')) || !alive.current) return;
      accept(await api.removeSubagent({ targets: ids, removeRules: true }), false);
    });
  }
  return <div className="subagent-view stack">
    {stale && <Notice retry={refresh}>状态刷新失败，当前显示上次读取的结果。</Notice>}
    <section className="card padded subagent-panel" aria-label="运行环境与状态概览">
      <Section title="运行环境与状态概览" actions={<IconBtn icon={RefreshCw} label="刷新子代理状态" className={loading ? 'subagent-refreshing' : ''} disabled={busy || loading} onClick={refresh} />} />
      <div className="subagent-runtime"><Terminal size={18} aria-hidden="true"/><Badge dot tone={pythonReady ? 'good' : 'amber'}>{pythonReady ? `Python ${status.python.version} · 就绪` : '需要 Python 3.10+'}</Badge><code>{status.python.executable || '未检测到解释器'}</code></div>
      {!pythonReady && <Notice>请安装 Python 3.10 或更高版本，或在高级选项中指定解释器路径。</Notice>}
      <div className="subagent-metrics"><Metric label="当前默认模型" value={<code>{c.model}</code>} /><Metric label="协议" value={protocols[c.protocol][0]}/><Metric label="推理强度" value={c.reasoningEffort}/>
        <Metric label="分块压缩" value={c.enableChunkCompaction ? `已开启 · ${c.compactTriggerPct}% 兜底` : `仅自动压缩 · ${c.compactTriggerPct}%`}/>
        <Metric label="凭据来源" value={<>{sourceNames[c.keySource]}<small>{maskOnly(c.maskedKey) || (status.userEnvHasKey ? '环境变量已配置' : '未配置密钥')}</small></>}/><Metric label="已部署客户端" value={`${installed.length} / ${status.harnesses.length}`}/><Metric label="最近更新" value={c.updatedAt ? time(c.updatedAt, true) : '尚未部署'}/></div>
      <div className="subagent-test-actions"><Btn icon={PlugZap} busy={pending === 'test'} disabled={busy || !!endpointError} onClick={() => action('test', async () => {
        const r = await api.testSubagent(testRequest(d, secret, probe && !probeHint, status, p)); if (alive.current) setResult(r);
      })}>验证子代理</Btn>
        <label className="check"><input type="checkbox" checked={probe && !probeHint} disabled={busy || !!probeHint} onChange={e => { setProbe(e.target.checked); setResult(null); }} />同时探测上游模型列表</label>
        {probeHint && <small>{probeHint}</small>}
      </div>
      {result && <ResultPanel r={result}/>}
    </section>
    <SubagentConfigPanel d={d} status={status} edit={edit} busy={busy} groups={rows} activeKeys={activeKeys} groupsLoading={groups.loading} keysLoading={keys.loading}
      groupsError={!!groups.error} keysError={!!keys.error} reloadGroups={groups.reload} reloadKeys={keys.reload} provider={p} group={g} secret={secret} setSecret={v => { setSecret(v); setResult(null); setFailure(''); }} secretEpoch={secretEpoch} />
    <HarnessPanel status={status} draft={d} select={targets => edit({ targets })} snippet={setSnippet} remove={remove} busy={busy}/>
    <footer className="subagent-footer"><div className="subagent-footer-state" role="status">{failure || invalid || pythonIssue || (edited ? '有尚未部署的更改' : `已选择 ${d.targets.length} 个客户端`)}</div>
      <div className="actions">{removable.length > 0 && <Btn kind="ghost" className="danger-hover" icon={Trash2} disabled={busy} onClick={() => remove(removable.map(h => h.id))}>移除全部已部署</Btn>}
        <Btn icon={FileDiff} busy={pending === 'preview'} disabled={busy || !!invalid} onClick={() => action('preview', async () => { const request = buildRequest(d, secret, status, p); const diff = await api.previewSubagent(request); if (alive.current) setPreview({ diff, request }); })}>预览变更 Diff</Btn>
        <Btn kind="primary" icon={CheckCheck} busy={pending === 'apply'} disabled={busy || !!(invalid || pythonIssue)} onClick={() => apply(buildRequest(d, secret, status, p))}>部署到所选客户端（{d.targets.length}）</Btn></div>
    </footer>
    {snippet && <SnippetDialog h={snippet} secret={secret} close={() => setSnippet(null)} />}
    {preview && <PreviewDialog diff={preview.diff} secret={secret} error={failure} issue={preview.diff.warnings.some(w => w.includes('Python 3.10')) ? '请先检查解释器路径。' : pythonIssue} busy={pending === 'apply'} close={() => setPreview(null)} apply={() => apply(preview.request)} />}
  </div>;
}
