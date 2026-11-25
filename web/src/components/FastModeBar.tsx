import { useState } from 'react';
import { Check, ChevronDown, ListChecks, ListPlus, Route, X } from 'lucide-react';
import type { GptFastConfig } from '@shared/types';
import {
  allowedGroupModels,
  buildAllFastModelMap,
  effectiveSpeedMode,
  isOnlyAstraGroup,
  isUltraFastGroup,
  sortModelsNewestFirst,
} from '@shared/constants';
import { api } from '../api/client';
import { systemNote, withSpeedMode } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { messageOf, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Choices, IconBtn } from './ui';

const speeds = [
  ['standard', '标准'],
  ['fast', '⚡ Fast'],
  ['ultrafast', '⚡⚡ UltraFast'],
] as const;

export default function FastModeBar() {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction(),
    cfg = s.fast;
  const [expanded, setExpanded] = useState(false);
  const mode = effectiveSpeedMode(cfg);
  const providers = s.providers.data ?? [];
  const codexProviders = providers.filter(p => p.appType === 'codex');
  const current = codexProviders.find(p => p.isCurrent);
  const menuProvider = current ?? codexProviders.find(p => p.id !== cfg.ultraFastProviderId && !isUltraFastGroup(p) && p.id !== cfg.astraOnlyProviderId && !isOnlyAstraGroup(p)) ?? codexProviders[0];
  const eligible = providers.filter(p => (p.appType === 'codex' || p.appType === 'gpt-native') && p.protocol === 'openai-responses');
  const candidates = [...eligible].sort((a, b) => Number(isUltraFastGroup(b)) - Number(isUltraFastGroup(a)));
  const astraCandidates = [...eligible].sort((a, b) => Number(isOnlyAstraGroup(b)) - Number(isOnlyAstraGroup(a)));
  const astraSelection = astraCandidates.find(p => p.id === cfg.astraOnlyProviderId);
  const astraBound = astraSelection ?? (current && isOnlyAstraGroup(current) ? current : astraCandidates.find(isOnlyAstraGroup));
  const bound = candidates.find(p => p.id === cfg.ultraFastProviderId);
  const autoMatch = current && isUltraFastGroup(current) ? current : candidates.find(isUltraFastGroup);
  const unbound = mode === 'ultrafast' && !bound;
  const showOptions = expanded || (s.fastReady && unbound);
  const codexTakeoverOn = !!s.proxy?.takeover.codex;
  const menuEnabled = codexTakeoverOn && cfg.catalogSpeedVariants !== false;
  const menuReady = menuEnabled && !!bound;
  const directUltra = mode === 'ultrafast' && !codexTakeoverOn;
  const syncHint = !current ? '先启用一个 Codex 供应商'
    : directUltra && !bound && !autoMatch ? '先绑定或配置 UltraFast 通道' : undefined;
  const caption = !s.fastReady ? '未读取'
    : mode === 'standard' ? '普通分组'
    : mode === 'fast' ? '普通分组 · priority'
    : !s.providers.data && s.providers.loading ? '正在读取供应商'
    : bound?.name ?? '未绑定 UltraFast 分组';
  const catalog = useResource('groups:' + s.identity, api.groups);
  const allGptModels = sortModelsNewestFirst([
    ...(current?.availableModels ?? []), current?.model ?? '',
    ...(catalog.data?.groups ?? []).filter(g => g.adapterCategory === 'gpt' && g.operating_access?.allowed !== false)
      .flatMap(allowedGroupModels),
  ]);
  const choices = sortModelsNewestFirst([...allGptModels, ...Object.keys(cfg.fastModelMap), ...Object.values(cfg.fastModelMap)]);
  const unmapped = allGptModels.filter(m => !m.endsWith('-fast') && !Object.hasOwn(cfg.fastModelMap, m));
  function targets(source: string) {
    const fast = choices.filter(m => m.endsWith('-fast') && m !== source);
    const others = choices.filter(m => !m.endsWith('-fast') && m !== source);
    return <>
      {fast.map(m => <option key={m} value={m}>⚡ {m}</option>)}
      <option value={source}>保持原模型 · {source}</option>
      {others.map(m => <option key={m} value={m}>{m}</option>)}
    </>;
  }
  const disabled = !s.fastReady || s.fastBusy || !!pending;
  async function write(next: GptFastConfig, sync = false) {
    try {
      if (
        sync &&
        !s.prefs.data?.backupBeforeSwitch &&
        !(await confirm('同步到 Codex？', '切换前备份未开启，写入可能覆盖现有配置。', '同步写入'))
      )
        return false;
      const result = await s.saveFast(withSpeedMode(next, effectiveSpeedMode(next)), sync);
      if (sync) notify('已同步到 Codex', systemNote(result));
      return true;
    } catch (e) {
      notify(sync ? '未能同步到 Codex' : '速度设置未保存', messageOf(e), true);
      return false;
    }
  }
  function patch(p: Partial<GptFastConfig>, sync = false) {
    void write({ ...cfg, ...p }, sync);
  }
  function enableCodexMenu() {
    void run('menu', async () => {
      try {
        if (!current && menuProvider) await api.activateProvider(menuProvider.id, { applyToSystem: false });
        if (!bound && (s.session?.authenticated || autoMatch)) {
          const { fastMode, proxy } = await api.setupUltraFast({ enableCodexMenu: true, applyToCodex: true });
          s.fastResource.replace(fastMode);
          if (proxy) s.proxyResource.replace(proxy);
        } else {
          // Switch to the proxy before syncing: even an unbound UltraFast preset can then write the menu.
          if (!codexTakeoverOn) {
            const { proxy } = await api.takeover({ appType: 'codex', enable: true });
            s.proxyResource.replace(proxy);
          }
          await s.saveFast({ ...cfg, catalogSpeedVariants: true }, !codexTakeoverOn);
          if (codexTakeoverOn) await api.syncCodexCatalog();
          if (!bound) setExpanded(true);
        }
      } finally {
        // A takeover may have succeeded even if the catalog write failed.
        s.refreshAll();
      }
      notify('已开启 Codex 免登录直选');
    });
  }
  function setupUltraFast() {
    void run('setup', async () => {
      const { fastMode } = await api.setupUltraFast({ applyToCodex: false });
      s.fastResource.replace(fastMode);
      s.refreshProviders();
      s.prefs.reload();
      notify('已自动绑定 Pro500 ultrafast 通道');
    });
  }
  function setupAstraOnly() {
    void run('astra-setup', async () => {
      try {
        const { fastMode, proxy, provider } = await api.setupAstraOnly({ enableProxyTakeover: true });
        s.fastResource.replace(fastMode);
        if (proxy) s.proxyResource.replace(proxy);
        notify('已启用 Astra 自动分流', provider.name);
      } finally {
        s.refreshAll();
      }
    });
  }
  function enableAstraTakeover() {
    void run('astra-takeover', async () => {
      if (!current && astraBound?.appType === 'codex') await api.activateProvider(astraBound.id, { applyToSystem: false });
      const { proxy } = await api.takeover({ appType: 'codex', enable: true });
      s.proxyResource.replace(proxy);
      s.refreshProviders();
      notify('已开启 Codex 接管');
    });
  }
  async function fillAll() {
    const map = buildAllFastModelMap(allGptModels, cfg.fastModelMap);
    if (await write({ ...cfg, fastModelMap: map })) notify(`已自动填充 ${Object.keys(map).length} 个模型映射`);
  }
  return (
    <section className="fast-bar card" data-speed={s.fastReady ? mode : undefined} aria-label="Codex 速度设置">
      <div className="fast-row">
        <b>速度</b>
        <Choices
          label="Codex 速度"
          className="speed-choices"
          items={speeds}
          value={s.fastReady ? mode : ''}
          disabled={disabled}
          change={speedMode => { if (speedMode !== mode) patch({ speedMode }); }}
        />
        <span className={'fast-state' + (s.fastReady && unbound ? ' unbound' : '')} role="status"
          title={unbound && autoMatch ? `自动匹配：${autoMatch.name}` : undefined}>
          {caption}
        </span>
        {cfg.routeAstraToOnlyAstra && <Badge tone={astraBound ? 'blue' : 'amber'}>Astra → {astraBound?.name ?? '未绑定'}</Badge>}
        <div className="fast-actions">
          <Btn kind="ghost" className="advanced-trigger" aria-expanded={expanded} aria-controls="fast-menu-options fast-options"
            onClick={() => setExpanded(!expanded)}>
            高级<ChevronDown size={12} />
          </Btn>
          <Btn kind="primary" disabled={disabled || !!syncHint} title={syncHint}
            onClick={() => void write(cfg, true)}>
            同步到 Codex
          </Btn>
        </div>
      </div>
      <div className="codex-menu-strip" role="group" aria-label="免登录 Codex 菜单直选">
        {menuReady && pending !== 'menu' ? (
          <>
            <span className="codex-menu-ready" role="status"><Check size={14} />免登录 Codex 菜单直选已开启</span>
            <span className="codex-menu-note">在 Codex 模型菜单直接选「⚡ Fast」走普通分组、「⚡⚡ UltraFast」自动走 Pro500 ultrafast，无需登录 ChatGPT、无需补丁</span>
          </>
        ) : (
          <>
            <Btn className="codex-menu-enable" icon={ListPlus} busy={pending === 'menu'}
              disabled={disabled || !menuProvider} onClick={enableCodexMenu}>
              一键开启 Codex 免登录直选 Fast / UltraFast
            </Btn>
            <span className="codex-menu-note">
              {!menuProvider && s.providers.data ? '请先添加 Codex 供应商。'
                : !current && menuProvider ? `将启用「${menuProvider.name}」作为 Codex 供应商。`
                : menuEnabled && !bound ? 'Fast 直选已开启；UltraFast 待绑定专属通道。'
                : '无需登录 ChatGPT，无需补丁。'}
            </span>
          </>
        )}
      </div>
      <div className="codex-menu-strip astra-route-strip" role="group" aria-labelledby="astra-route-title">
        <strong id="astra-route-title">仅 Astra 自动分流（Only astra · 0.08x）</strong>
        <label className="check">
          <input type="checkbox" checked={!!cfg.routeAstraToOnlyAstra} disabled={disabled}
            onChange={e => patch({ routeAstraToOnlyAstra: e.target.checked }, codexTakeoverOn)} />
          自动将 Astra 请求发往仅 Astra 分组
        </label>
        <select aria-label="仅 Astra 供应商" value={cfg.astraOnlyProviderId ?? ''} disabled={disabled || !s.providers.data}
          onChange={e => patch({ astraOnlyProviderId: e.target.value || null }, codexTakeoverOn)}>
          <option value="">自动匹配 Only astra 供应商</option>
          {cfg.astraOnlyProviderId && !astraSelection && <option value={cfg.astraOnlyProviderId} disabled>已绑定的供应商不可用</option>}
          {astraCandidates.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Btn icon={Route} className="codex-menu-enable" disabled={disabled} busy={pending === 'astra-setup'} onClick={setupAstraOnly}>
          一键配置并启用 Only astra
        </Btn>
        {cfg.routeAstraToOnlyAstra && astraBound && !codexTakeoverOn && <Btn disabled={disabled || (!current && astraBound.appType !== 'codex')}
          busy={pending === 'astra-takeover'} onClick={enableAstraTakeover}>开启 Codex 接管</Btn>}
        <span className="codex-menu-note" role="status">
          {!cfg.routeAstraToOnlyAstra ? '未启用 Astra 自动分流。'
            : !astraBound ? '未绑定：请选择供应商或一键配置 Only astra 分组。'
            : codexTakeoverOn ? `已生效：Astra 模型（如 gpt-6.2-astra）自动发往 ${astraBound.name}，其他模型走当前分组，UltraFast 仍走 Pro500 ultrafast。`
            : `已绑定 ${astraBound.name}，开启本地代理 Codex 接管后自动按模型分流。`}
        </span>
      </div>
      <div className={'fast-fold ' + (showOptions ? 'open' : '')} inert={!showOptions}>
        <div>
          <fieldset className="fast-options" disabled={disabled}>
            <div id="fast-menu-options" className="fast-menu-options" hidden={!expanded}>
              <div>
                <label className="check catalog-speed-check">
                  <input type="checkbox" checked={cfg.catalogSpeedVariants !== false} aria-describedby="fast-catalog-guide"
                    onChange={e => patch({ catalogSpeedVariants: e.target.checked }, codexTakeoverOn)} />
                  在 Codex 模型菜单生成 ⚡ Fast / ⚡⚡ UltraFast 直选项（免登录 ChatGPT · 代理模式）
                </label>
                <p className="fast-catalog-guide" id="fast-catalog-guide">无需登录 ChatGPT 账号、无需补丁（Codex 更新不失效）。开启本地代理的 Codex 接管后，可直接在 Codex 模型下拉框里选「⚡ Fast（普通分组）」或「⚡⚡ UltraFast（自动路由至 Pro500 ultrafast）」。</p>
              </div>
              <label className="check">
                <input type="checkbox" checked={Boolean(cfg.respectClientServiceTier)}
                  onChange={e => patch({ respectClientServiceTier: e.target.checked })} />
                兼容 Codex 原生速度菜单（若已登录 ChatGPT 账号）
              </label>
            </div>
            <div className="ultrafast-binding">
              <label htmlFor="ultrafast-provider">UltraFast 专属通道</label>
              <select id="ultrafast-provider" value={cfg.ultraFastProviderId ?? ''} disabled={!s.providers.data}
                onChange={e => patch({ ultraFastProviderId: e.target.value || null })}>
                <option value="">自动匹配 UltraFast 供应商</option>
                {cfg.ultraFastProviderId && !bound && (
                  <option value={cfg.ultraFastProviderId} disabled>
                    {s.providers.loading ? '正在读取供应商' : '已绑定的供应商不可用'}
                  </option>
                )}
                {candidates.map(p => <option key={p.id} value={p.id}>{isUltraFastGroup(p) ? '⚡⚡ ' : ''}{p.name}</option>)}
              </select>
              {s.session?.authenticated && (
                <Btn busy={pending === 'setup'} onClick={setupUltraFast}>一键配置 Pro500 ultrafast</Btn>
              )}
            </div>
            <div id="fast-options" className="fast-advanced" hidden={!expanded}>
              <label className="check">
                <input type="checkbox" checked={cfg.strategy !== 'tier_only'}
                  onChange={e => patch({ strategy: e.target.checked ? 'hybrid' : 'tier_only' })} />
                同时映射 -fast 专用型号
              </label>
              <div className="fast-mappings">
                <div className="model-heading">
                  <b>模型映射（已填 {Object.keys(cfg.fastModelMap).length} 项）</b>
                  <Btn kind="ghost" icon={ListChecks} disabled={!unmapped.length} onClick={() => void fillAll()}>自动填满全部模型</Btn>
                </div>
                <div className="mapping-list">
                  {sortModelsNewestFirst(Object.keys(cfg.fastModelMap)).map(source => (
                    <div className="mapping-row" key={source}>
                      <code title={source}>{source}</code><span aria-hidden="true">→</span>
                      <select className="mono" aria-label={`${source} 的 Fast 模型`} value={cfg.fastModelMap[source]}
                        onChange={e => patch({ fastModelMap: { ...cfg.fastModelMap, [source]: e.target.value } })}>
                        {targets(source)}
                      </select>
                      <IconBtn label={`删除 ${source} 映射`} icon={X} onClick={() => {
                        const next = { ...cfg.fastModelMap };
                        delete next[source];
                        patch({ fastModelMap: next });
                      }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </fieldset>
        </div>
      </div>
    </section>
  );
}
