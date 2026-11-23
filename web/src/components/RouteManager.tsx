import { useState } from 'react';
import { ArrowRight, ListMinus, ListPlus, Play, Plus, RefreshCw, Route, Trash2 } from 'lucide-react';
import { allowedGroupModels, MODEL_SLUG, providerModelNames, sortModelsNewestFirst } from '@shared/constants';
import type { ModelRouteInput, ModelRouteRule, ProviderView, RouteSourceClient } from '@shared/types';
import { api } from '../api/client';
import { systemNote } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Choices, Empty, Field, IconBtn, Modal, Notice, Skeleton, Table, Toggle } from './ui';

const clients = [['claude', 'Claude Code'], ['codex', 'Codex']] as const;
const filters = [['all', '全部'], ['claude', 'Claude Code → 其他模型'], ['codex', 'Codex → Claude']] as const;
const clientOptions = clients.map(([k, label]) => <option key={k} value={k}>{label}</option>);
const modelOptions = (names: string[]) => names.map(m => <option key={m} value={m}>{m === '*' ? '通配 * 兜底' : m}</option>);
const conversion = (client: RouteSourceClient, p: ProviderView) => client === 'claude'
  ? p.protocol === 'openai-responses' ? 'Anthropic → Responses' : '直通'
  : p.protocol === 'anthropic-messages' ? 'Responses → Anthropic' : '直通';

interface EditorData {
  providers: ProviderView[];
  models: Map<string, string[]>;
  sources: string[];
}
function AddRoute({ providers, models, sources, initial, busy, save, close }: EditorData & {
  initial: RouteSourceClient; busy: boolean; save: (rule: ModelRouteInput) => void; close: () => void;
}) {
  const [client, setClient] = useState(initial), [providerId, setProvider] = useState('');
  const [model, setModel] = useState(''), [source, setSource] = useState('');
  const pickable = providers.filter(p => models.get(p.id)?.length);
  const p = pickable.find(p => p.id === providerId) ?? pickable.find(p => conversion(client, p) !== '直通') ?? pickable[0];
  const targetModel = model || (p && models.get(p.id)?.[0]) || '';
  const sourceModel = source || targetModel;
  return <Modal title="添加路由" close={close} busy={busy}>
    <form className="form-stack route-form" onSubmit={e => {
      e.preventDefault();
      if (p && targetModel) save({ enabled: true, sourceClient: client, sourceModel, targetProviderId: p.id, targetModel });
    }}>
      <Field label="来源客户端"><select value={client} onChange={e => { setClient(e.target.value as RouteSourceClient); setProvider(''); setModel(''); }}>{clientOptions}</select></Field>
      <Field label="目标供应商"><select value={p?.id ?? ''} onChange={e => { setProvider(e.target.value); setModel(''); }}>
        {providers.map(p => <option key={p.id} value={p.id} disabled={!models.get(p.id)?.length}>{p.name}</option>)}
      </select></Field>
      <Field label="目标模型"><select value={targetModel} onChange={e => setModel(e.target.value)}>{modelOptions(models.get(p?.id ?? '') ?? [])}</select></Field>
      <Field label="请求模型"><select value={source} onChange={e => setSource(e.target.value)}>
        <option value="">与目标模型相同</option>{modelOptions(sources)}
      </select></Field>
      <div className="modal-foot"><Btn disabled={busy} onClick={close}>取消</Btn><Btn kind="primary" type="submit" busy={busy} disabled={!p || !targetModel || !(sourceModel === '*' || MODEL_SLUG.test(sourceModel))}>添加路由</Btn></div>
    </form>
  </Modal>;
}

export default function RouteManager() {
  const s = useStudio(), { notify, confirm } = useFeedback(), { run, pending } = useAction();
  const resource = useResource('model-routes', api.routes), catalog = useResource('route-groups:' + s.identity, api.groups);
  const [filter, setFilter] = useState<RouteSourceClient | 'all'>('all'), [adding, setAdding] = useState(false);
  const providers = (s.providers.data ?? []).filter(p => p.protocol !== 'gemini-native'), rules = resource.data ?? [], groups = catalog.data?.groups ?? [];
  const models = new Map(providers.map(p => [p.id, [...new Set([
    ...providerModelNames(p, groups.find(g => g.id === p.phuketGroupId)), ...Object.values(p.claudeModelMap ?? {}),
    ...rules.filter(r => r.targetProviderId === p.id).map(r => r.targetModel),
  ])]]));
  const sources = ['*', ...sortModelsNewestFirst([...models.values()].flat().concat(groups.filter(g => g.protocol).flatMap(allowedGroupModels), rules.map(r => r.sourceModel)).filter(m => MODEL_SLUG.test(m)))];
  const ready = resource.data !== null && s.providers.data !== null && !pending;
  const rows = rules.filter(r => filter === 'all' || r.sourceClient === filter);
  const proxy = s.proxy;
  const currentCodex = providers.some(p => p.appType === 'codex' && p.isCurrent);
  const codexTakeover = !!proxy?.takeover.codex;
  async function save(next: ModelRouteInput[]) {
    resource.replace(await api.saveRoutes({ rules: next })); notify('路由已保存');
  }
  const change = (rule: ModelRouteRule, patch: Partial<ModelRouteInput>) => void run('save', () => save(rules.map(r => r.id === rule.id ? { ...r, ...patch } : r)));
  return <section className="stack">
    <div className="route-intro">
      <div><h2>跨协议模型路由</h2><p>Claude Code → GPT / Grok / 国产模型　·　Codex → Claude</p></div>
      {proxy?.running ? <Badge dot tone="good">代理运行中 :{proxy.settings.port}</Badge> : <Btn icon={Play} disabled={!!pending || !proxy} busy={pending === 'start'} onClick={() => void run('start', async () => {
        s.proxyResource.replace(await api.startProxy()); s.overview.reload(); notify('代理已启动');
      })}>一键启动代理</Btn>}
    </div>
    <div className="route-toolbar">
      <Choices label="来源客户端" items={filters} value={filter} change={setFilter} />
      <div className="actions">
        <Btn kind="primary" icon={ListPlus} disabled={!ready} busy={pending === 'fill'} onClick={() => void run('fill', async () => {
          try {
            const result = await api.autoPopulateRoutes({ sourceClient: 'all', syncCodexCatalog: true });
            resource.replace(result.rules); setFilter('all'); notify(`新增 ${result.addedCount} 条路由`, systemNote(result.system));
          } catch (e) { resource.reload(); throw e; }
        })}>一键填充全部跨协议路由</Btn>
        <Btn icon={Plus} disabled={!ready || ![...models.values()].some(ms => ms.length)} onClick={() => setAdding(true)}>添加路由</Btn>
        {(currentCodex || rules.some(r => r.sourceClient === 'codex')) && <Btn kind="ghost" icon={RefreshCw} disabled={!ready || !currentCodex || !codexTakeover} title={!currentCodex ? '请先启用 Codex 供应商' : !codexTakeover ? '需先在「代理与接管」开启 Codex 本地代理接管，才能将跨协议模型同步到 Codex 目录' : undefined} busy={pending === 'sync'} onClick={() => void run('sync', async () => {
          notify('Codex 目录已同步', systemNote(await api.syncCodexCatalog()));
        })}>同步到 Codex 目录</Btn>}
        {codexTakeover && <Btn kind="ghost" icon={ListMinus} disabled={!ready} busy={pending === 'clear-catalog'} title="保留路由规则和速度选项" onClick={() => void run('clear-catalog', async () => {
          notify('已从 Codex 目录移除跨协议模型', systemNote(await api.clearCodexCatalogRoutes()));
        })}>移除 Codex 跨协议模型</Btn>}
      </div>
    </div>
    {resource.error && <Notice retry={resource.reload}>{resource.error}</Notice>}
    {s.providers.error && <Notice retry={s.providers.reload}>{s.providers.error}</Notice>}
    {resource.loading && !resource.data ? <Skeleton /> : rows.length ? <div className="route-table"><Table heads={['启用', '来源客户端', '请求模型', '', '目标供应商', '目标模型', '协议', '操作']}>
      {rows.map(r => {
        const p = providers.find(p => p.id === r.targetProviderId);
        return <tr key={r.id}>
          <td><Toggle label={`启用 ${r.sourceModel} 路由`} on={r.enabled} disabled={!ready} change={() => change(r, { enabled: !r.enabled })} /></td>
          <td><select className="client-choice" aria-label="来源客户端" value={r.sourceClient} disabled={!ready} onChange={e => change(r, { sourceClient: e.target.value as RouteSourceClient })}>{clientOptions}</select></td>
          <td><select aria-label="请求模型" value={r.sourceModel} disabled={!ready} onChange={e => change(r, { sourceModel: e.target.value })}>{modelOptions(sources)}</select></td>
          <td><ArrowRight size={13} aria-hidden="true" /></td>
          <td><select aria-label="目标供应商" value={r.targetProviderId} disabled={!ready} onChange={e => {
            const id = e.target.value, names = models.get(id)!;
            change(r, { targetProviderId: id, targetModel: names.includes(r.targetModel) ? r.targetModel : names[0] });
          }}>{providers.map(p => <option key={p.id} value={p.id} disabled={!models.get(p.id)?.length}>{p.name}</option>)}</select></td>
          <td><select aria-label="目标模型" value={r.targetModel} disabled={!ready} onChange={e => change(r, { targetModel: e.target.value })}>{modelOptions(models.get(r.targetProviderId) ?? [r.targetModel])}</select></td>
          <td><Badge>{p ? conversion(r.sourceClient, p) : '—'}</Badge></td>
          <td><IconBtn icon={Trash2} label="删除路由" disabled={!ready} onClick={() => void run('delete', async () => {
            if (await confirm('删除路由？', `${r.sourceModel} → ${p?.name ?? ''} · ${r.targetModel}`, '删除')) await save(rules.filter(x => x.id !== r.id));
          })} /></td>
        </tr>;
      })}
    </Table></div> : !resource.error && <Empty icon={Route} title={filter === 'all' ? '暂无模型路由' : '没有匹配的路由'} />}
    {adding && <AddRoute providers={providers} models={models} sources={sources} initial={filter === 'codex' ? 'codex' : 'claude'} busy={!!pending} close={() => setAdding(false)} save={rule => void run('add', async () => {
      await save([...rules, rule]); setAdding(false);
    })} />}
  </section>;
}
