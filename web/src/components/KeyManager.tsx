import { useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, Image as ImageIcon, KeyRound, Plus, Power, Trash2, X } from 'lucide-react';
import { allowedGroupModels, buildSuggestedClaudeMap, classifyPhuketGroup, pickRecommendedModel, protocolForApp, defaultBaseUrlForApp } from '@shared/constants';
import type { CreatePhuketKeyResult, PhuketApiKeyView, PhuketGroup } from '@shared/types';
import { api } from '../api/client';
import { credits, groupApp, num, saleRate } from '../lib/display';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { messageOf, useResource } from '../lib/resource';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Empty, Field, IconBtn, Modal, Notice, Section, Skeleton, Table } from './ui';

type Issued = { result: CreatePhuketKeyResult; group: PhuketGroup };
const status = { active: '启用', inactive: '停用', quota_exhausted: '额度耗尽', expired: '已过期' };
function CreateKey({
  groups,
  initial,
  created,
  close,
}: {
  groups: PhuketGroup[];
  initial: PhuketGroup | null;
  created: (k: Issued) => void;
  close: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? groups[0]?.id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const group = groups.find((g) => g.id === id);
    if (!group || busy) return;
    const f = new FormData(e.currentTarget),
      name = String(f.get('name') ?? '').trim(),
      quota = f.get('quota'),
      expiry = f.get('expiry');
    if (!name) {
      setError('请输入密钥名称。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.createKey({
        name,
        group_id: group.id,
        ...(quota ? { quota: Number(quota) } : {}),
        ...(expiry ? { expires_at: new Date(String(expiry)).toISOString() } : {}),
      });
      created({ result, group });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="新建密钥" close={close} busy={busy}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="名称">
          <input name="name" required maxLength={512} autoFocus />
        </Field>
        <Field label="绑定分组">
          <select required value={id ?? ''} onChange={(e) => setId(Number(e.target.value))}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="额度（credits）">
            <input type="number" name="quota" min="0" step="any" placeholder="不限" />
          </Field>
          <Field label="到期时间（可选）">
            <input type="datetime-local" name="expiry" />
          </Field>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="modal-foot">
          <Btn disabled={busy} onClick={close}>
            取消
          </Btn>
          <Btn kind="primary" type="submit" busy={busy} disabled={!id}>
            创建密钥
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
export default function KeyManager({
  groups,
  initial,
  clear,
  revision,
}: {
  groups: PhuketGroup[];
  initial: PhuketGroup | null;
  clear: () => void;
  revision: number;
}) {
  const s = useStudio(),
    { notify, confirm } = useFeedback(),
    { pending, run } = useAction();
  const [page, setPage] = useState(1),
    [creating, setCreating] = useState(false),
    [issued, setIssued] = useState<Issued | null>(null),
    [imported, setImported] = useState(false);
  const size = 12,
    keys = useResource(`keys:${s.identity}:${page}:${revision}`, (signal) =>
      api.keys({ page, pageSize: size }, signal),
    );
  const pages = Math.max(1, Math.ceil((keys.data?.total ?? 0) / size));
  function close() {
    setCreating(false);
    clear();
  }
  function created(k: Issued) {
    setIssued(k);
    setImported(false);
    close();
    setPage(1);
    keys.reload();
    s.usage.reload();
  }
  async function importIssued() {
    if (!issued?.group.protocol) return;
    const { group: g, result: r } = issued;
    const appType = g.supportedAppTypes.includes(s.client) ? s.client : groupApp(g);
    const protocol = protocolForApp(appType);
    const available = allowedGroupModels(g);
    // Some upstream lists only return masked keys; the issue response is the one usable copy.
    const p = await api.createProvider({
      name: r.item.name || g.name,
      appType, protocol,
      baseUrl: defaultBaseUrlForApp(appType, g),
      apiKey: r.key,
      phuketGroupId: g.id,
      phuketGroupName: g.name,
      phuketPlatform: g.platform,
      rateMultiplier: saleRate(g) ?? g.rate_multiplier,
      availableModels: available,
      model: pickRecommendedModel(available, protocol),
      ...(protocol === 'anthropic-messages' ? { claudeModelMap: buildSuggestedClaudeMap(available) } : {}),
    });
    setImported(true);
    s.refreshProviders();
    notify('已导入到供应商', p.name);
  }
  async function remove(k: PhuketApiKeyView) {
    if (!(await confirm('删除密钥？', `「${k.name}」将无法再用于请求，此操作不可撤销。`, '删除'))) return;
    await api.deleteKey(k.id);
    if (issued?.result.item.id === k.id) setIssued(null);
    if (page > 1 && keys.data?.items.length === 1) setPage(page - 1);
    else keys.reload();
    s.usage.reload();
    notify('密钥已删除');
  }
  return (
    <div className="stack">
      <Section
        title="我的密钥"
        count={keys.data?.total}
        actions={
          <Btn kind="primary" icon={Plus} disabled={!groups.length} onClick={() => setCreating(true)}>
            新建密钥
          </Btn>
        }
      />
      {issued && (
        <div className="issued">
          <div>
            <strong>密钥已创建</strong>
            <p>完整密钥仅在此显示一次。</p>
            <input
              readOnly
              value={issued.result.key}
              onFocus={(e) => e.target.select()}
              className="mono"
              aria-label="新密钥"
            />
          </div>
          <Btn icon={Copy} onClick={() => void copyText(issued.result.key, notify)}>
            复制
          </Btn>
          {issued.group.adapterCategory === 'image_prompt' ? (
            <Btn icon={ImageIcon} onClick={() => s.navigate('/extensions', 'image-prompt')}>
              前往配置生图提示词
            </Btn>
          ) : (
            <Btn
              disabled={!!pending || imported}
              icon={Download}
              onClick={() => void run('issued', importIssued)}
            >
              {imported ? '已导入' : '导入到供应商'}
            </Btn>
          )}
          <IconBtn icon={X} label="隐藏新密钥" onClick={() => setIssued(null)} />
        </div>
      )}
      {keys.error && <Notice retry={keys.reload}>{keys.error}</Notice>}
      {keys.loading && !keys.data ? (
        <Skeleton />
      ) : keys.data?.items.length ? (
        <Table heads={['名称 / 密钥', '分组', '额度', '今日 / 累计消耗', '状态', '操作']}>
          {keys.data.items.map((k) => {
            const g = groups.find((g) => g.id === k.group_id),
              routing = g ?? (k.group ? classifyPhuketGroup(k.group) : null);
            const cost = s.usage.data?.dashboard?.keyUsageFallback?.find((v) => v.api_key_id === k.id);
            return (
              <tr key={k.id}>
                <td>
                  <b>{k.name}</b>
                  <small className="mono">{k.key_display || '••••••••'}</small>
                </td>
                <td>{g?.name || k.group?.name || '未绑定'}</td>
                <td>{k.quota > 0 ? `${num(k.quota_used)} / ${num(k.quota)}` : '不限'}</td>
                <td>
                  {credits(k.today_actual_cost ?? cost?.today_actual_cost)}
                  <small>{credits(k.total_actual_cost ?? cost?.total_actual_cost)}</small>
                </td>
                <td>
                  <Badge dot tone={k.status === 'active' ? 'good' : 'muted'}>
                    {status[k.status] || '未知'}
                  </Badge>
                </td>
                <td>
                  <div className="actions">
                    {routing?.adapterCategory === 'image_prompt' && k.status === 'active' ? (
                      <IconBtn
                        label="配置生图提示词"
                        icon={ImageIcon}
                        disabled={!!pending}
                        onClick={() => s.navigate('/extensions', 'image-prompt')}
                      />
                    ) : (
                      <IconBtn
                        label="导入到供应商"
                        icon={Download}
                        disabled={
                          !!pending ||
                          !routing?.protocol ||
                          k.status !== 'active' ||
                          (imported && issued?.result.item.id === k.id)
                        }
                        onClick={() =>
                          void run('import', async () => {
                            if (issued?.result.item.id === k.id) return importIssued();
                            const p = await api.importKey(k.id, {
                              appType: routing?.supportedAppTypes.includes(s.client)
                                ? s.client
                                : g
                                  ? groupApp(g)
                                  : routing?.supportedAppTypes[0],
                            });
                            s.refreshProviders();
                            notify('已导入到供应商', p.name);
                          })
                        }
                      />
                    )}
                    <IconBtn
                      label={k.status === 'active' ? '停用密钥' : '启用密钥'}
                      icon={Power}
                      disabled={!!pending || !['active', 'inactive'].includes(k.status)}
                      onClick={() =>
                        void run('status', async () => {
                          await api.updateKey(k.id, {
                            status: k.status === 'active' ? 'inactive' : 'active',
                          });
                          keys.reload();
                        })
                      }
                    />
                    <IconBtn
                      icon={Trash2}
                      label="删除密钥"
                      disabled={!!pending}
                      onClick={() => void run('delete', () => remove(k))}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      ) : (
        !keys.error && <Empty icon={KeyRound} title="暂无密钥" />
      )}
      {(pages > 1 || page > 1) && (
        <div className="pager">
          <IconBtn
            icon={ChevronLeft}
            disabled={page === 1}
            label="上一页"
            onClick={() => setPage(page - 1)}
          />
          <span>
            {page} / {pages}
          </span>
          <IconBtn
            icon={ChevronRight}
            disabled={page >= pages}
            label="下一页"
            onClick={() => setPage(page + 1)}
          />
        </div>
      )}
      {(creating || initial) && (
        <CreateKey groups={groups} initial={initial} created={created} close={close} />
      )}
    </div>
  );
}
