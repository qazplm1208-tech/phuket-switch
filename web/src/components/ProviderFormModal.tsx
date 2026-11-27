import { useState, type FormEvent } from 'react';
import type {
  AppType,
  ClaudeModelMap,
  CreateProviderRequest,
  PhuketGroup,
  ProviderView,
} from '@shared/types';
import {
  allowedGroupModels,
  buildSuggestedClaudeMap,
  canCreateGroupKey,
  pickRecommendedModel,
  sortModelsNewestFirst,
  FALLBACK_PHUKET_GROUPS,
  defaultBaseUrlForApp,
  protocolForApp,
} from '@shared/constants';
import { api } from '../api/client';
import {
  APPS,
  appName,
  groupApp,
  isClaude,
  protocolName,
  saleRate,
  supportedGroup,
  withFastEnabled,
} from '../lib/display';
import { useFeedback } from '../lib/feedback';
import { messageOf, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { Btn, Disclosure, Field, Modal, Notice } from './ui';

const CUSTOM = ':custom:';
const mapLabels = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', defaultModel: '默认模型' } as const;
export default function ProviderFormModal({
  initialApp,
  group,
  provider: p,
  close,
  saved,
}: {
  initialApp: AppType;
  group?: PhuketGroup;
  provider?: ProviderView;
  close: () => void;
  saved?: (p: ProviderView) => void;
}) {
  const s = useStudio(),
    { notify } = useFeedback();
  const catalog = useResource('groups:' + s.identity, api.groups);
  const groups = (catalog.data?.groups ?? (catalog.error ? FALLBACK_PHUKET_GROUPS : [])).filter(
    supportedGroup,
  );
  if (group && !groups.some((g) => g.id === group.id)) groups.unshift(group);
  const logged = !!s.session?.authenticated;
  const keys = useResource(logged ? 'keys-all:' + s.identity : null,
    (signal) => api.keys({ page: 1, pageSize: 100 }, signal));
  const [app, setApp] = useState(p?.appType ?? initialApp);
  // undefined follows the catalog default; null is an explicit custom source.
  const [source, setSource] = useState<number | null | undefined>(group?.id ?? p?.phuketGroupId);
  const allowed = s.session?.account?.allowed_groups;
  let gid = source;
  if (source === undefined && logged && !p && !group) {
    const eligible = groups.filter(g => g.supportedAppTypes.includes(app) && canCreateGroupKey(g, allowed));
    const nativeApp = app === 'claude-desktop' ? 'claude' : app;
    gid = (eligible.find(g => groupApp(g) === nativeApp) ?? eligible[0])?.id;
  }
  const chosen = groups.find((g) => g.id === gid);
  const [nameOverride, setName] = useState(p?.name);
  const name = nameOverride ?? chosen?.name ?? '';
  const defaultUrl = defaultBaseUrlForApp(app, chosen);
  const [urlOverride, setUrl] = useState<string | undefined>(p?.baseUrl);
  const url = urlOverride ?? defaultUrl;
  const urlOrigin = URL.parse(url)?.origin;
  const originalOrigin = p && URL.parse(p.baseUrl)?.origin;
  const originChanged = !!p && !!urlOrigin && urlOrigin !== originalOrigin;
  const groupKeys = (keys.data?.items ?? []).filter(k => k.group_id === gid && k.status === 'active');
  const [keyChoice, setKeyChoice] = useState<string | undefined>(p ? 'keep' : undefined);
  const keyMode = !logged || !chosen || (originChanged && (!keyChoice || keyChoice === 'keep')) ? 'manual' : keyChoice ?? (groupKeys[0]
    ? `key:${groupKeys[0].id}` : keys.data ? 'auto' : 'pending');
  const requireSecret = keyMode === 'manual' && (!p || originChanged || (logged && !!chosen));
  const keyHint = keyMode === 'pending' ? (keys.error ? '请选择密钥来源，或重试加载。' : '正在加载分组密钥…')
    : keyMode.startsWith('key:') ? '将使用账号中该分组的可用密钥，无需手动填写。'
    : keyMode === 'auto' ? (keys.data && !groupKeys.length ? '该分组暂无可用密钥，保存时将自动新建并绑定。' : '保存时将为该分组新建并绑定密钥。')
    : keyMode === 'keep' ? '保存时不会更改当前密钥。' : '请输入要绑定的 API 密钥。';
  const groupModels = allowedGroupModels(chosen);
  const [included, setModels] = useState<string[] | undefined>(p?.availableModels?.length ? p.availableModels : undefined);
  const [modelOverride, setModel] = useState<string | undefined>(p?.model || undefined);
  const [customModel, setCustomModel] = useState(false);
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [mapOverrides, setMapping] = useState<ClaudeModelMap>(() =>
    Object.fromEntries(Object.entries(p?.claudeModelMap ?? {}).filter(([, value]) => value?.trim())),
  );
  // Derive untouched slots from the live catalog, so a late response never replaces edits.
  const models = included ?? sortModelsNewestFirst(groupModels);
  const candidates = groupModels.length ? groupModels : models;
  const protocol = protocolForApp(app);
  const supportsFast = protocol === 'openai-responses';
  const model = modelOverride ?? pickRecommendedModel(candidates, protocol) ?? '';
  const mapping = { ...(isClaude(app) ? buildSuggestedClaudeMap(candidates) : {}), ...mapOverrides };
  const modelChoices = sortModelsNewestFirst([
    ...groupModels, ...(p?.availableModels ?? []), ...models, ...customNames, model, ...Object.values(mapping),
  ]);
  const options = modelChoices.map(m => <option key={m} value={m}>{m}</option>);
  function fillClaude() {
    const all = groupModels.length ? sortModelsNewestFirst(groupModels) : modelChoices;
    setModels(all);
    setModel(pickRecommendedModel(all, 'anthropic-messages'));
    setMapping(buildSuggestedClaudeMap(all));
    setCustomModel(false);
  }
  const [override, setOverride] = useState<'inherit' | 'on' | 'off'>(
    p?.codexFastConfig ? (p.codexFastConfig.enabled ? 'on' : 'off') : 'inherit',
  );
  const [queue, setQueue] = useState(p?.inFailoverQueue ?? false),
    [priority, setPriority] = useState(String(p?.priority ?? 10));
  const [notes, setNotes] = useState(p?.notes ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  function choose(id: string) {
    const g = groups.find((g) => String(g.id) === id);
    setSource(g?.id ?? null);
    setKeyChoice(undefined);
    setModels(undefined);
    setModel(undefined);
    setCustomModel(false);
    setCustomNames([]);
    setNewName('');
    setMapping({});
    if (url === defaultUrl) setUrl(undefined);
    if (!g) return;
    const a = g.supportedAppTypes.includes(app) ? app : groupApp(g);
    setApp(a);
    setName(g.name);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || keyMode === 'pending') return;
    setError('');
    const key = keyMode === 'manual' ? String(new FormData(e.currentTarget).get('secret') ?? '').trim() : '';
    if (!name.trim() || (requireSecret && !key)) {
      setError(!name.trim() ? '请填写供应商名称。' : '请填写 API 密钥。');
      return;
    }
    try {
      const u = new URL(url);
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
        throw new Error();
    } catch {
      setError('请输入 HTTP(S) 地址，不能包含凭据、查询参数或片段。');
      return;
    }
    const baseUrl = url.trim();
    const body: Partial<CreateProviderRequest> = {
      name: name.trim(),
      protocol,
      baseUrl,
      ...(keyMode.startsWith('key:') ? { phuketKeyId: Number(keyMode.slice(4)) } : {}),
      ...(keyMode === 'auto' ? { autoCreatePhuketKey: true } : {}),
      ...(key ? { apiKey: key } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      availableModels: sortModelsNewestFirst(models),
      inFailoverQueue: queue,
      priority: Number(priority),
      notes: notes.trim(),
      ...(isClaude(app)
        ? {
            claudeModelMap: Object.fromEntries(
              Object.entries(mapping)
                .filter(([, v]) => v?.trim())
                .map(([k, v]) => [k, v.trim()]),
            ),
          }
        : supportsFast && override !== 'inherit'
          ? { codexFastConfig: withFastEnabled(p?.codexFastConfig ?? s.fast, override === 'on') }
          : {}),
      ...(chosen
        ? {
            phuketGroupId: chosen.id,
            phuketGroupName: chosen.name,
            phuketPlatform: chosen.platform,
            rateMultiplier: saleRate(chosen) ?? chosen.rate_multiplier,
          }
        : {}),
    };
    setBusy(true);
    try {
      const out = p
        ? await api.updateProvider(p.id, {
            ...body,
            ...(source === null && p.phuketGroupId != null ? { phuketGroupId: null } : {}),
            ...(override === 'inherit' && p.codexFastConfig ? { codexFastConfig: null } : {}),
          })
        : await api.createProvider({
            ...body,
            name: name.trim(),
            baseUrl,
            protocol,
            appType: app,
          } satisfies CreateProviderRequest);
      if (body.autoCreatePhuketKey) s.usage.reload();
      s.refreshProviders();
      notify(p ? '供应商已更新' : '供应商已添加', out.name);
      saved?.(out);
      close();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={p ? '编辑供应商' : '添加配置'} wide close={close} busy={busy}>
      <form className="form-stack" onSubmit={submit} autoComplete="off">
        <div className="form-grid">
          <Field label="配置来源">
            <select value={gid ?? ''} onChange={(e) => choose(e.target.value)}>
              <option value="">
                自定义供应商
              </option>
              {gid != null && !chosen && <option value={gid}>{p?.phuketGroupName ?? gid}</option>}
              {groups
                .filter((g) => !p || g.supportedAppTypes.includes(p.appType))
                .map((g) => (
                  <option
                    value={g.id}
                    key={g.id}
                    disabled={
                      g.operating_access?.allowed === false ||
                      (g.is_exclusive && Array.isArray(allowed) && !allowed.includes(g.id))
                    }
                  >
                    {g.name} · {g.rate_multiplier}×
                  </option>
                ))}
            </select>
          </Field>
          <Field label="客户端">
            <select
              value={app}
              disabled={!!p}
              onChange={(e) => {
                const a = e.target.value as AppType;
                setApp(a);
                if (url === defaultUrl) setUrl(undefined);
              }}
            >
              {(chosen?.supportedAppTypes ?? APPS).map((a) => (
                <option value={a} key={a}>
                  {appName[a]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {catalog.error && <Notice retry={catalog.reload}>分组目录暂不可用，显示离线参考分组。</Notice>}
        <Field label="供应商名称">
          <input
            autoFocus
            required
            maxLength={512}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：日常开发"
          />
        </Field>
        <div className="form-grid">
          <Field
            label={`端点地址 · ${protocolName(protocol)}`}
            hint={originChanged ? '地址来源已更改，不能保留当前密钥。请填写新地址的 API 密钥，或选择对应的 PhuketAI 分组密钥。' : undefined}
          >
            <input
              className="mono"
              type="url"
              required
              value={url}
              onChange={(e) => {
                const next = e.target.value;
                const nextOrigin = URL.parse(next)?.origin;
                if (p && nextOrigin !== urlOrigin) setKeyChoice(nextOrigin === originalOrigin ? 'keep' : 'manual');
                setUrl(next);
              }}
            />
          </Field>
          <div className="form-stack">
            {logged && chosen && (
              <Field label="API 密钥" hint={keyHint}>
                <select value={keyMode} onChange={e => setKeyChoice(e.target.value)}>
                  {keyMode === 'pending' && <option value="pending" disabled>{keys.error ? '请选择密钥来源' : '正在加载…'}</option>}
                  {p && !originChanged && <option value="keep">保留当前密钥 · {p.maskedKey || '••••'}</option>}
                  {groupKeys.map(k => <option key={k.id} value={`key:${k.id}`}>使用已有密钥 · {k.name} ({k.key_display})</option>)}
                  <option value="auto">自动为该分组新建 API 密钥</option>
                  <option value="manual">手动填写 API 密钥…</option>
                </select>
              </Field>
            )}
            {logged && chosen && keys.error && <Notice retry={keys.reload}>账号密钥加载失败。</Notice>}
            {keyMode === 'manual' && (
              <Field label={logged && chosen ? '手动填写 API 密钥' : 'API 密钥'}>
                <input
                  key={JSON.stringify([gid, urlOrigin])}
                  className="mono"
                  type="password"
                  name="secret"
                  autoComplete="off"
                  required={requireSecret}
                  placeholder={p && !requireSecret ? `${p.maskedKey || '••••'} · 留空保留原密钥` : '输入 API 密钥'}
                />
              </Field>
            )}
            {!logged && chosen && <div className="inline"><Btn kind="ghost" onClick={() => s.setLogin(true)}>登录 PhuketAI 后免填密钥</Btn></div>}
          </div>
        </div>
        <Field label="默认模型">
          <select className="mono" value={customModel ? CUSTOM : model} onChange={e => {
            setCustomModel(e.target.value === CUSTOM);
            setModel(e.target.value === CUSTOM ? '' : e.target.value);
          }}>
            <option value="">未指定</option>
            {options}
            {gid == null && <option value={CUSTOM}>自定义模型…</option>}
          </select>
        </Field>
        {customModel && <Field label="自定义模型"><input className="mono" autoFocus value={model} onChange={e => setModel(e.target.value)} /></Field>}
        {isClaude(app) && (
          <section className="model-section">
            <div className="model-heading"><b>Claude 模型映射</b>
              <Btn kind="ghost" disabled={!modelChoices.length} onClick={fillClaude}>自动填充全部</Btn>
            </div>
            <div className="form-grid">
              {(Object.keys(mapLabels) as (keyof ClaudeModelMap)[]).map(k => (
                <Field key={k} label={mapLabels[k]}>
                  <select className="mono" value={mapping[k] ?? ''} onChange={e => setMapping({ ...mapOverrides, [k]: e.target.value })}>
                    <option value="">未指定</option>{options}
                  </select>
                </Field>
              ))}
            </div>
          </section>
        )}
        <section className="model-section">
          <div className="model-heading"><b>可用模型</b><small>已包含 {models.length} 个模型</small>
            {chosen && <Btn kind="ghost" disabled={!groupModels.length} onClick={() => setModels(sortModelsNewestFirst([...models, ...groupModels]))}>全选分组全部模型</Btn>}
          </div>
          <div className="model-checklist">
            {modelChoices.map(m => <label className="check model-chip" key={m}>
              <input type="checkbox" checked={models.includes(m)} onChange={e => setModels(e.target.checked ? [...models, m] : models.filter(n => n !== m))} />
              <code>{m}</code>
            </label>)}
          </div>
          {gid == null && <Disclosure title="添加自定义模型">
            <div className="inline">
              <input aria-label="模型名称" className="mono" placeholder="模型名称" value={newName} onChange={e => setNewName(e.target.value)} />
              <Btn disabled={!newName.trim()} onClick={() => {
                const name = newName.trim();
                setCustomNames([...customNames, name]);
                setModels(sortModelsNewestFirst([...models, name]));
                setNewName('');
              }}>添加</Btn>
            </div>
          </Disclosure>}
        </section>
        <Disclosure title="更多选项">
          <div className="form-stack">
            {supportsFast && (
              <Field label="GPT Fast">
                <select value={override} onChange={(e) => setOverride(e.target.value as typeof override)}>
                  <option value="inherit">继承全局设置</option>
                  <option value="on">覆盖为开启 Fast</option>
                  <option value="off">覆盖为关闭 Fast</option>
                </select>
              </Field>
            )}
            <div className="inline">
              <label className="check">
                <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
                加入故障转移队列
              </label>
              <label className="inline">
                优先级
                <input
                  className="number-input"
                  type="number"
                  min="0"
                  required
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </label>
            </div>
            <Field label="备注">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </Disclosure>
        {error && <Notice tone="bad">{error}</Notice>}
        <footer className="modal-foot">
          <Btn onClick={close} disabled={busy}>
            取消
          </Btn>
          <Btn kind="primary" type="submit" busy={busy} disabled={keyMode === 'pending'}>
            保存配置
          </Btn>
        </footer>
      </form>
    </Modal>
  );
}
