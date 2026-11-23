import { useEffect, useMemo, useState } from 'react';
import { Copy, Image as ImageIcon, RefreshCw, Trash2 } from 'lucide-react';
import { sortModelsNewestFirst } from '@shared/constants';
import type { ApplyImagePromptRequest, ImagePromptTarget } from '@shared/types';
import { api } from '../api/client';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { systemNote, time, num } from '../lib/display';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Disclosure, Field, IconBtn, Notice, Section, Skeleton } from './ui';

type KeyChoice = '__auto__' | '__create__' | '__saved__' | '__manual__' | `key:${number}`;
type TargetState = Record<ImagePromptTarget, boolean>;
const targetOptions: ReadonlyArray<{ id: ImagePromptTarget; name: string; path: string }> = [
  { id: 'codex', name: 'Codex', path: '~/.codex/AGENTS.md' },
  { id: 'claude', name: 'Claude Code', path: '~/.claude/CLAUDE.md' },
];
function preferredModel(models: string[], saved?: string | null) {
  return (saved && models.includes(saved) ? saved : undefined) ??
    (models.includes('gpt-image-2') ? 'gpt-image-2' : models[0] ?? '');
}
export default function ImagePromptPanel() {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const status = useResource(`image-prompt:${s.identity}`, api.imagePrompt);
  const groups = useResource(`image-prompt-groups:${s.identity}`, api.groups);
  const logged = !!s.session?.authenticated;
  const keys = useResource(
    logged ? `image-prompt-keys:${s.identity}` : null,
    (signal) => api.keys({ page: 1, pageSize: 100 }, signal),
  );
  const config = status.data?.config;
  const liveTargets = status.data?.liveTargets;
  const imageGroups = (groups.data?.groups ?? []).filter((g) => g.adapterCategory === 'image_prompt');
  const imageGroupIds = imageGroups.map((g) => g.id).join(',');
  const [groupId, setGroupId] = useState<number | null>(null),
    [defaultModel, setDefaultModel] = useState(''),
    [selectedModels, setSelectedModels] = useState<string[]>([]),
    [targetState, setTargetState] = useState<TargetState>({ codex: true, claude: false }),
    [customInstructions, setCustomInstructions] = useState(''),
    [keyChoice, setKeyChoice] = useState<KeyChoice>('__auto__'),
    [manualKey, setManualKey] = useState('');
  const savedGroupId = config?.groupId ?? null;
  useEffect(() => {
    const next = imageGroups.find((g) => g.id === savedGroupId)?.id ?? imageGroups[0]?.id ?? null;
    setGroupId((old) => (old != null && imageGroups.some((g) => g.id === old) ? old : next));
  }, [imageGroupIds, savedGroupId]);
  const activeGroup = imageGroups.find((g) => g.id === groupId) ?? imageGroups[0];
  const modelNames = useMemo(() => {
    const names = activeGroup?.models
      .filter((m) => m.operating_access?.allowed !== false)
      .map((m) => m.name) ?? [];
    return sortModelsNewestFirst(names.length ? names : ['gpt-image-2']);
  }, [activeGroup]);
  const modelKey = modelNames.join('\u0000');
  const savedModelsKey = (config?.models ?? []).join('\u0000');
  const savedDefaultModel = config?.defaultModel ?? '';
  useEffect(() => {
    setDefaultModel(preferredModel(modelNames, savedDefaultModel));
  }, [modelKey, savedDefaultModel]);
  useEffect(() => {
    const preferred = preferredModel(modelNames, savedDefaultModel);
    const saved = config?.models ?? [];
    const next = saved.length ? modelNames.filter((model) => saved.includes(model)) : [...modelNames];
    if (preferred && !next.includes(preferred)) next.push(preferred);
    setSelectedModels(next.length ? next : modelNames);
  }, [modelKey, savedDefaultModel, savedModelsKey]);
  useEffect(() => {
    const configured = Boolean(
      config?.updatedAt ||
        config?.enabled ||
        config?.groupId != null ||
        liveTargets?.codex.injected ||
        liveTargets?.claude.injected,
    );
    setTargetState({
      codex: configured ? Boolean(config?.targets.codex || liveTargets?.codex.injected) : true,
      claude: configured ? Boolean(config?.targets.claude || liveTargets?.claude.injected) : false,
    });
  }, [
    config?.updatedAt,
    config?.enabled,
    config?.groupId,
    config?.targets.codex,
    config?.targets.claude,
    liveTargets?.codex.injected,
    liveTargets?.claude.injected,
  ]);
  useEffect(() => {
    setCustomInstructions(config?.customInstructions ?? '');
  }, [config?.customInstructions]);
  const maskedKey = config?.maskedKey ?? '';
  useEffect(() => {
    setKeyChoice(logged ? '__auto__' : maskedKey ? '__saved__' : '__manual__');
  }, [logged, maskedKey]);
  const activeKeys = (keys.data?.items ?? []).filter(
    (key) =>
      key.status === 'active' &&
      activeGroup != null &&
      (key.group_id === activeGroup.id || key.group?.id === activeGroup.id),
  );
  const fallbackKeyChoice: KeyChoice = logged ? '__auto__' : maskedKey ? '__saved__' : '__manual__';
  const selectedKeyChoice: KeyChoice =
    keyChoice.startsWith('key:') && !activeKeys.some((key) => `key:${key.id}` === keyChoice)
      ? fallbackKeyChoice
      : keyChoice;
  const selectedTargets = targetOptions.filter(({ id }) => targetState[id]).map(({ id }) => id);
  const injectedTargets = targetOptions.filter(({ id }) => liveTargets?.[id].injected).map(({ id }) => id);
  const manualMissing = selectedKeyChoice === '__manual__' && !manualKey.trim();
  const canApply =
    !!activeGroup &&
    !!defaultModel &&
    selectedModels.length > 0 &&
    selectedTargets.length > 0 &&
    !manualMissing;
  const keyName = config?.keyName && maskedKey ? `${config.keyName} · ${maskedKey}` : maskedKey || '未配置';
  function reloadAll() {
    status.reload();
    groups.reload();
    keys.reload();
  }
  function toggleModel(model: string) {
    setSelectedModels((old) => {
      if (model === defaultModel) return old.includes(model) ? old : [...old, model];
      return old.includes(model) ? old.filter((item) => item !== model) : [...old, model];
    });
  }
  async function apply() {
    if (!activeGroup || !canApply) return;
    const body: ApplyImagePromptRequest = {
      groupId: activeGroup.id,
      defaultModel,
      models: modelNames.filter((model) => selectedModels.includes(model)),
      targets: selectedTargets,
      customInstructions: customInstructions.trim(),
    };
    if (selectedKeyChoice === '__create__') body.autoCreatePhuketKey = true;
    else if (selectedKeyChoice === '__manual__') body.apiKey = manualKey.trim();
    else if (selectedKeyChoice.startsWith('key:')) body.phuketKeyId = Number(selectedKeyChoice.slice(4));
    const out = await api.applyImagePrompt(body);
    status.replace(out.status);
    reloadAll();
    notify('已写入生图系统提示词', systemNote(out.system));
  }
  async function remove() {
    if (!injectedTargets.length) return;
    if (!(await confirm('移除生图区块？', '仅移除标记区块，不影响文件中的其他系统提示词。', '移除'))) return;
    const out = await api.removeImagePrompt({ targets: injectedTargets });
    status.replace(out.status);
    reloadAll();
    notify('已移除生图区块', systemNote(out.system));
  }
  const loading = (status.loading && !status.data) || (groups.loading && !groups.data);
  return (
    <div className="image-prompt-panel stack">
      <Section
        title="生图分组系统提示词适配"
        actions={<IconBtn icon={RefreshCw} label="刷新生图适配状态" onClick={reloadAll} />}
      />
      <p className="image-prompt-intro">
        生图分组不能直接作为 Codex 对话模型接入，需先使用 Codex 普通对话模型，并将 OpenAI 兼容生图端口、可用模型与生图专用密钥写入系统提示词。
      </p>
      {status.error && <Notice retry={status.reload}>{status.error}</Notice>}
      {groups.error && <Notice retry={groups.reload}>{groups.error}</Notice>}
      {logged && keys.error && <Notice retry={keys.reload}>{keys.error}</Notice>}
      {loading ? (
        <Skeleton rows={3} />
      ) : (
        <>
          {status.data && (
            <section className="card padded image-prompt-status">
              <div className="image-prompt-status-targets">
                {targetOptions.map(({ id, name, path }) => {
                  const injected = liveTargets?.[id].injected ?? false;
                  return (
                    <div className="image-prompt-status-target" key={id}>
                      <div className="spread">
                        <b>{name}</b>
                        <Badge dot tone={injected ? 'good' : 'muted'}>
                          {injected ? '已写入' : '未写入'}
                        </Badge>
                      </div>
                      <code>{liveTargets?.[id].path || path}</code>
                    </div>
                  );
                })}
              </div>
              <div className="image-prompt-status-meta">
                <span>
                  生图密钥 <b className="mono">{keyName}</b>
                </span>
                <span>
                  默认模型 <b className="mono">{config?.defaultModel || '未配置'}</b>
                </span>
                <span>
                  最近更新 <b>{time(config?.updatedAt, true)}</b>
                </span>
              </div>
            </section>
          )}
          {!logged && (
            <Notice>
              登录 PhuketAI 后可自动获取或新建生图密钥；未登录时仍可沿用已保存密钥或手动填写。{' '}
              <Btn kind="secondary" onClick={() => s.setLogin(true)}>
                登录 PhuketAI
              </Btn>
            </Notice>
          )}
          {!groups.loading && !imageGroups.length && (
            <Notice retry={groups.reload}>暂未获取到生图-image 分组，刷新后重试。</Notice>
          )}
          <section className="card padded image-prompt-config">
            <div className="image-prompt-card-heading">
              <div>
                <h3>配置写入内容</h3>
                <p>选择生图分组、模型与写入目标，系统会生成可直接调用的本地提示词。</p>
              </div>
              {activeGroup && <Badge tone="blue">{activeGroup.name}</Badge>}
            </div>
            <div className="form-grid">
              <Field label="生图分组">
                {imageGroups.length > 1 ? (
                  <select value={activeGroup?.id ?? ''} onChange={(event) => setGroupId(Number(event.target.value))}>
                    {imageGroups.map((group) => (
                      <option value={group.id} key={group.id}>
                        {group.name} · {num(group.rate_multiplier)}× · {group.models.length} 个模型
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="image-prompt-static-select">
                    {activeGroup ? `${activeGroup.name} · ${num(activeGroup.rate_multiplier)}× · ${activeGroup.models.length} 个模型` : '暂无生图分组'}
                  </div>
                )}
              </Field>
              <Field label="生图 API 密钥">
                <select value={selectedKeyChoice} onChange={(event) => setKeyChoice(event.target.value as KeyChoice)}>
                  {logged && (
                    <option value="__auto__">
                      {activeKeys[0]
                        ? `自动获取生图密钥（优先复用已有「${activeKeys[0].name}」，无则自动新建）`
                        : '自动获取生图密钥（自动为生图分组新建）'}
                    </option>
                  )}
                  {logged &&
                    activeKeys.map((key) => (
                      <option value={`key:${key.id}`} key={key.id}>
                        已有密钥 · {key.name}（{key.key_display}）
                      </option>
                    ))}
                  {logged && <option value="__create__">新建生图分组 API 密钥（自动创建）</option>}
                  {!logged && maskedKey && <option value="__saved__">沿用已保存密钥（{maskedKey}）</option>}
                  <option value="__manual__">手动填写 API 密钥…</option>
                </select>
                {selectedKeyChoice === '__manual__' && (
                  <input
                    type="password"
                    value={manualKey}
                    onChange={(event) => setManualKey(event.target.value)}
                    placeholder="输入 OpenAI 兼容生图 API 密钥"
                    autoComplete="off"
                  />
                )}
              </Field>
            </div>
            <div className="form-grid">
              <Field label="默认生图模型">
                <select value={defaultModel} onChange={(event) => {
                  const model = event.target.value;
                  setDefaultModel(model);
                  setSelectedModels((old) => (old.includes(model) ? old : [...old, model]));
                }}>
                  {modelNames.map((model) => (
                    <option value={model} key={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="image-prompt-model-count">
                <span>当前写入模型</span>
                <b>{selectedModels.length} / {modelNames.length}</b>
              </div>
            </div>
            <fieldset className="image-prompt-model-fieldset">
              <legend>写入提示词的可选模型</legend>
              <div className="model-chips">
                {modelNames.map((model) => {
                  const selected = selectedModels.includes(model);
                  const isDefault = model === defaultModel;
                  return (
                    <button
                      type="button"
                      className={`model-chip ${selected ? 'selected' : ''}`}
                      aria-pressed={selected}
                      key={model}
                      onClick={() => toggleModel(model)}
                    >
                      <code>{model}</code>
                      {isDefault && <Badge tone="blue">默认</Badge>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="image-prompt-targets">
              <legend>写入目标</legend>
              {targetOptions.map(({ id, name, path }) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={targetState[id]}
                    onChange={(event) => setTargetState((old) => ({ ...old, [id]: event.target.checked }))}
                  />
                  <span>
                    <b>{name}</b>
                    <small>{liveTargets?.[id].path || path}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="footnote">
              仅更新 &lt;!-- PHUKET_SWITCH_IMAGE_GEN_START/END --&gt; 标记区块，完整保留原有系统提示词，并在写入前自动备份。
            </p>
            <Disclosure title="补充要求（可选）">
              <Field label="补充要求">
                <textarea
                  value={customInstructions}
                  onChange={(event) => setCustomInstructions(event.target.value)}
                  placeholder="例如：生成图片默认保存到 ./assets/images/ 目录"
                />
              </Field>
            </Disclosure>
            <div className="actions image-prompt-actions">
              <Btn
                kind="primary"
                icon={ImageIcon}
                busy={pending === 'apply'}
                disabled={!canApply || !!pending}
                onClick={() => void run('apply', apply)}
              >
                写入系统提示词
              </Btn>
              {!!injectedTargets.length && (
                <Btn
                  kind="ghost"
                  className="danger-hover"
                  icon={Trash2}
                  busy={pending === 'remove'}
                  disabled={!!pending}
                  onClick={() => void run('remove', remove)}
                >
                  移除生图区块
                </Btn>
              )}
            </div>
          </section>
          <section className="card padded image-prompt-preview">
            <div className="spread image-prompt-card-heading">
              <div>
                <h3>生图系统提示词预览</h3>
                <p>实时显示打码后的待写入内容。</p>
              </div>
              <Btn
                icon={Copy}
                disabled={!status.data?.previewMarkdown}
                onClick={() => void copyText(status.data?.previewMarkdown ?? '', notify)}
              >
                复制预览
              </Btn>
            </div>
            <pre className="skill-preview mono">{status.data?.previewMarkdown || '暂无预览内容。'}</pre>
            <p className="footnote">预览中密钥已自动打码；点击「写入系统提示词」时会将真实生图密钥写入本地文件。</p>
          </section>
        </>
      )}
    </div>
  );
}
