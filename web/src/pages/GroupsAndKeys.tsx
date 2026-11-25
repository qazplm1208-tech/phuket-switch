import { Fragment, useState } from 'react';
import { Boxes, Image as ImageIcon, Plus, RefreshCw, UserRound } from 'lucide-react';
import { FALLBACK_PHUKET_GROUPS, isOnlyAstraGroup, isUltraFastGroup } from '@shared/constants';
import type { PhuketGroup, PhuketModelPricing, PhuketPricingInterval } from '@shared/types';
import { api } from '../api/client';
import { credits, groupApp, num, saleRate, supportedGroup } from '../lib/display';
import { useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { useAction, useFeedback } from '../lib/feedback';
import RechargeView from '../components/RechargeView';
import AccountOverview from '../components/AccountOverview';
import KeyManager from '../components/KeyManager';
import LoginGate from '../components/LoginGate';
import ProviderFormModal from '../components/ProviderFormModal';
import { Badge, Btn, Choices, Disclosure, Empty, IconBtn, Notice, Skeleton, Table } from '../components/ui';

const categories = [
  ['all', '全部可用'],
  ['claude', 'Claude'],
  ['gpt', 'GPT'],
  ['gemini', 'Gemini'],
  ['antigravity', '反重力'],
  ['domestic', '国产模型'],
  ['grok', 'Grok'],
  ['image_prompt', '生图适配'],
] as const;
const tabs = [
  ['plaza', '分组广场'],
  ['keys', '我的密钥'],
  ['usage', '账户与用量'],
  ['recharge', '余额充值'],
] as const;
const price = (v?: number | null) =>
  v == null ? '—' : `¥${(v * 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}`;
const billedPrice = (
  pricing: PhuketModelPricing | null,
  field: 'input' | 'output' | 'cache',
  interval?: PhuketPricingInterval,
) => {
  if (!pricing) return '—';
  const requestPrice = interval?.per_request_price ?? pricing.per_request_price;
  const imageBilled =
    pricing.billing_mode === 'image' || pricing.image_output_price != null || pricing.per_request_price != null;
  if (imageBilled) {
    if (field === 'input' && pricing.image_input_price != null) return `${price(pricing.image_input_price)} (图)`;
    if (field === 'output' && pricing.image_output_price != null) return `${price(pricing.image_output_price)} (图)`;
    if (requestPrice != null) return `¥${num(requestPrice)}/次`;
    return '按图片计费';
  }
  const value =
    field === 'input'
      ? interval?.input_price ?? pricing.input_price
      : field === 'output'
        ? interval?.output_price ?? pricing.output_price
        : interval?.cache_read_price ?? pricing.cache_read_price;
  return price(value);
};
function GroupCard({
  g,
  logged,
  blocked,
  issue,
  add,
  onConfigureImage,
}: {
  g: PhuketGroup;
  logged: boolean;
  blocked: boolean;
  issue: () => void;
  add: () => void;
  onConfigureImage: () => void;
}) {
  const sale = saleRate(g);
  const ultraFast = isUltraFastGroup(g);
  const imagePrompt = g.adapterCategory === 'image_prompt';
  return (
    <article className="card group-card">
      <div className="spread">
        <h3>{g.name}</h3>
        <Badge tone={sale != null ? 'amber' : 'muted'}>
          {sale != null && <del>{num(g.pricing_offer?.standard_rate)}×</del>}
          {num(sale ?? g.rate_multiplier)}×
        </Badge>
      </div>
      <div className="tags">
        {imagePrompt ? (
          <Badge tone="blue">系统提示词 · OpenAI 兼容</Badge>
        ) : (
          <Badge>{g.adapterCategory === 'antigravity' ? '反重力 · 多协议' : g.protocol === 'gemini-native' ? 'Gemini 原生' : g.protocol === 'anthropic-messages' ? 'Anthropic' : 'GPT 原生'}</Badge>
        )}
        {ultraFast && <Badge tone="amber">UltraFast 专属</Badge>}
        {isOnlyAstraGroup(g) && <Badge tone="blue">仅 Astra</Badge>}
        {g.is_exclusive && <Badge tone="blue">专属</Badge>}
        {sale != null && <Badge tone="amber">限时优惠</Badge>}
        {blocked && <Badge>账户受限</Badge>}
      </div>
      {ultraFast && <p className="group-card-note">UltraFast 专用高速分组；普通 Fast 直接在普通分组开启即可。</p>}
      {imagePrompt && (
        <p className="group-card-note">需在 Codex / Claude 使用普通对话模型，通过系统提示词调用 /v1/images/generations</p>
      )}
      <Disclosure title="模型与价格" meta={`${g.models.length} 个模型`}>
        {g.models.length ? (
          <>
            <small>{imagePrompt ? '按次或图片计费' : '¥ / 百万 tokens'}</small>
            <Table heads={['模型', '输入', '输出', '缓存读取']}>
              {g.models.map((m, i) => (
                <Fragment key={i}>
                  <tr>
                    <td>
                      <code>{m.name}</code>
                      {m.operating_access?.allowed === false && <small>受限</small>}
                    </td>
                    <td>{billedPrice(m.pricing, 'input')}</td>
                    <td>{billedPrice(m.pricing, 'output')}</td>
                    <td>{billedPrice(m.pricing, 'cache')}</td>
                  </tr>
                  {m.pricing?.intervals.map((v, j) => (
                    <tr key={j}>
                      <td>
                        <small>
                          {v.tier_label ||
                            `${num(v.min_tokens)}–${v.max_tokens == null ? '∞' : num(v.max_tokens)} tokens`}
                        </small>
                      </td>
                      <td>{billedPrice(m.pricing, 'input', v)}</td>
                      <td>{billedPrice(m.pricing, 'output', v)}</td>
                      <td>{billedPrice(m.pricing, 'cache', v)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </Table>
          </>
        ) : (
          <p className="muted">暂无模型价格</p>
        )}
      </Disclosure>
      <div className="actions">
        {imagePrompt ? (
          <>
            <Btn icon={ImageIcon} kind="primary" disabled={blocked} onClick={onConfigureImage}>
              配置生图提示词
            </Btn>
            {logged && (
              <Btn disabled={blocked} onClick={issue}>
                用此分组新建密钥
              </Btn>
            )}
          </>
        ) : (
          <>
            {logged && (
              <Btn disabled={blocked} onClick={issue}>
                用此分组新建密钥
              </Btn>
            )}
            <Btn icon={Plus} kind={logged ? 'ghost' : 'secondary'} disabled={blocked} onClick={add}>
              添加为供应商
            </Btn>
          </>
        )}
      </div>
    </article>
  );
}
export default function GroupsAndKeys() {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const r = useResource('groups:' + s.identity, api.groups);
  const [category, setCategory] = useState<string>('all'),
    [manual, setManual] = useState<PhuketGroup | null>(null),
    [issueGroup, setIssue] = useState<PhuketGroup | null>(null),
    [revision, bump] = useState(0);
  const tab = s.tab === 'keys' || s.tab === 'usage' || s.tab === 'recharge' ? s.tab : 'plaza',
    logged = !!s.session?.authenticated;
  const groups = r.data?.groups ?? (r.error ? FALLBACK_PHUKET_GROUPS : []);
  const plazaGroups = groups.filter((g) => supportedGroup(g) || g.adapterCategory === 'image_prompt');
  const blocked = (g: PhuketGroup) =>
    logged &&
    (g.operating_access?.allowed === false ||
      (g.is_exclusive &&
        Array.isArray(s.session?.account?.allowed_groups) &&
        !s.session.account.allowed_groups.includes(g.id)));
  const shown = plazaGroups.filter((g) => category === 'all' || category === g.adapterCategory);
  const media = groups.filter((g) => g.adapterCategory === 'media_coming_soon');
  const offline =
    !!r.error || (groups.length > 0 && groups.every((g) => g.status === 'unknown' && !g.models.length));
  function refresh() {
    r.reload();
    s.account.reload();
    s.auth.reload();
    s.usage.reload();
    bump((n) => n + 1);
  }
  return (
    <div className="stack">
      <div className="tab-bar">
        <Choices
          tabs
          label="分组与密钥"
          items={tabs}
          value={tab}
          change={(v) => {
            setIssue(null);
            s.navigate('/groups', v);
          }}
        />
        <div className="actions">
          {logged ? (
            <Btn kind="ghost" className="account-balance" title="余额充值" onClick={() => s.navigate('/groups', 'recharge')}>
              {credits(s.session?.account?.balance)} · 充值
            </Btn>
          ) : (
            <Btn kind="ghost" icon={UserRound} onClick={() => s.setLogin(true)}>
              登录 PhuketAI
            </Btn>
          )}
          <IconBtn label="刷新账户与分组" icon={RefreshCw} onClick={refresh} />
        </div>
      </div>
      {tab === 'plaza' ? (
        <>
          <div className="toolbar">
            <Choices items={categories} label="分组分类" value={category} change={setCategory} />
          </div>
          {offline && <Notice retry={r.reload}>当前为离线参考目录，倍率与权限以账户实时数据为准。</Notice>}
          {r.loading && !r.data ? (
            <Skeleton />
          ) : shown.length ? (
            <div className="group-grid">
              {shown.map((g) => (
                <GroupCard
                  key={g.id}
                  g={g}
                  logged={logged}
                  blocked={blocked(g)}
                  issue={() => {
                    setIssue(g);
                    s.navigate('/groups', 'keys');
                  }}
                  add={() => setManual(g)}
                  onConfigureImage={() => s.navigate('/extensions', 'image-prompt')}
                />
              ))}
            </div>
          ) : (
            <Empty icon={Boxes} title="此分类暂无适配分组" />
          )}
          <Disclosure title="视频分组（暂未适配，后续支持）">
            <div className="tags">
              {(media.length
                ? media
                : FALLBACK_PHUKET_GROUPS.filter((g) => g.adapterCategory === 'media_coming_soon')
              ).map((g) => (
                <Badge key={g.id}>{g.name}</Badge>
              ))}
            </div>
          </Disclosure>
        </>
      ) : tab === 'keys' ? (
        logged ? (
          <KeyManager
            groups={plazaGroups.filter((g) => !blocked(g))}
            initial={issueGroup}
            clear={() => setIssue(null)}
            revision={revision}
          />
        ) : (
          <LoginGate title="登录 PhuketAI 查看和管理密钥" />
        )
      ) : tab === 'recharge' ? (
        <RechargeView />
      ) : (
        <>
          <AccountOverview />
          {logged && (
            <div className="actions end">
              <Btn
                kind="ghost"
                disabled={!!pending}
                onClick={() =>
                  void run('logout', async () => {
                    if (!(await confirm('退出 PhuketAI？', '已保存的本地供应商不受影响。', '退出登录'))) return;
                    await api.logout();
                    s.sessionChanged({ authenticated: false, account: null, baseUrl: s.baseUrl });
                    notify('已退出登录');
                  })
                }
              >
                退出登录
              </Btn>
            </div>
          )}
        </>
      )}
      {manual && (
        <ProviderFormModal
          group={manual}
          initialApp={manual.supportedAppTypes.includes(s.client) ? s.client : groupApp(manual)}
          close={() => setManual(null)}
          saved={(p) => s.selectClient(p.appType)}
        />
      )}
    </div>
  );
}
