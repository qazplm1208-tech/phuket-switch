import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { PaymentOrderResult, PaymentOrdersQuery } from '@shared/types';
import { PHUKET_BASE_URL } from '@shared/constants';
import { safePaymentUrl } from '@shared/payment';
import { api } from '../api/client';
import { credits, time } from '../lib/display';
import { useResource } from '../lib/resource';
import { copyText, useAction, useFeedback } from '../lib/feedback';
import { useStudio } from '../lib/studio';
import LoginGate from './LoginGate';
import { Badge, Btn, Choices, Field, IconBtn, Metric, Modal, Notice, Section, Skeleton, Table } from './ui';

const redeemTypeLabels = new Map<string, string>([
  ['admin_balance', '余额充值（管理员）'], ['balance', '余额充值'],
  ['concurrency', '并发增加'], ['admin_concurrency', '并发增加'],
  ['subscription', '订阅兑换'], ['trial', '试用权限'],
]);
const purchase = `${PHUKET_BASE_URL}/purchase`;
const presets = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].map(n => [String(n), `¥${n}`] as const);
const filters = [['', '全部'], ['PENDING', '待支付'], ['COMPLETED', '已完成'], ['FAILED', '失败'], ['REFUNDED', '已退款']] as const;
const states: Record<string, string> = { PENDING: '待支付', PAID: '已支付', COMPLETED: '已完成', FAILED: '失败', EXPIRED: '已过期', CANCELLED: '已取消', CANCELED: '已取消', REFUNDED: '已退款' };
const paid = (s: string) => s === 'PAID' || s === 'COMPLETED';
const money = (n: number) => Number.isFinite(n) ? `¥${n.toFixed(2)}` : '—';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const methodName = (s: string) => ({ alipay: '支付宝', wechat: '微信支付', wxpay: '微信支付', stripe: '银行卡' })[s?.toLowerCase()] ?? s;

function ExternalButton({ url, label, primary = false }: { url: string; label: string; primary?: boolean }) {
  const { run } = useAction();
  const href = safePaymentUrl(url);
  if (!href) return null;
  return <Btn kind={primary ? 'primary' : 'ghost'} icon={ExternalLink} onClick={() => void run('open', async () => {
    if (window.phuketDesktop?.openExternal) await window.phuketDesktop.openExternal(href);
    else window.open(href, '_blank', 'noopener,noreferrer');
  })}>{label}</Btn>;
}

function PaymentQR({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, value, { scale: 6, margin: 4 }).catch(() => setError(true));
  }, [value]);
  return error ? <Notice>无法生成二维码，请使用支付链接。</Notice> : <canvas className="payment-qr" ref={ref} aria-label="支付二维码" />;
}

function PaymentModal({ initial, close, reload }: { initial: PaymentOrderResult; close: () => void; reload: () => void }) {
  const [order, set] = useState(initial), [now, setNow] = useState(Date.now), [pollError, setError] = useState(false);
  const { notify, confirm } = useFeedback(), { pending, run } = useAction();
  const refreshBalance = useStudio().account.reload;
  const waiting = order.status === 'PENDING';
  const expires = Date.parse(order.expires_at ?? ''), seconds = Math.max(0, Math.ceil((expires - now) / 1000));
  const expired = seconds === 0;
  const link = safePaymentUrl(order.pay_url);
  function merge(next: PaymentOrderResult) {
    set(old => old.status !== 'PENDING' ? old : { ...old, ...next, pay_url: next.pay_url ?? old.pay_url, qr_code: next.qr_code ?? old.qr_code });
  }
  useEffect(() => {
    if (waiting) return;
    reload();
    if (paid(order.status)) refreshBalance();
  }, [waiting, order.status, refreshBalance, reload]);
  useEffect(() => {
    if (!waiting || !Number.isFinite(expires)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting, expires]);
  useEffect(() => {
    if (!waiting || pending) return;
    const controller = new AbortController();
    let reading = false;
    const timer = window.setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await api.order(order.order_id, controller.signal);
        if (!controller.signal.aborted) { merge(next); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { reading = false; }
    }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [order.order_id, waiting, pending]);
  return <Modal title={paid(order.status) ? '支付成功' : '充值订单'} close={close} busy={!!pending}>
    <div className="stack">
      <div className="spread"><Metric label="实付金额" value={money(order.pay_amount)} /><Badge tone={paid(order.status) ? 'good' : 'muted'}>{states[order.status] ?? '未知状态'}</Badge></div>
      <div className="spread"><span>订单编号</span><code>{order.out_trade_no}</code></div>
      {waiting && Number.isFinite(seconds) && <div className="spread"><span>支付剩余时间</span><b className="mono">{expired ? '已到期' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</b></div>}
      {waiting && !expired && order.qr_code && <PaymentQR key={order.qr_code} value={order.qr_code} />}
      {waiting && !expired && link && <div className="actions"><ExternalButton url={link} label="打开支付页面" primary /><Btn icon={Copy} onClick={() => void copyText(link, notify)}>复制支付链接</Btn></div>}
      {waiting && !expired && !order.qr_code && !link && <Notice>暂无可用的支付链接或二维码。</Notice>}
      {pollError && waiting && <Notice>暂时无法查询支付状态，稍后将自动重试。</Notice>}
      {waiting && <div className="modal-foot"><Btn disabled={!!pending} onClick={() => void run('cancel', async () => {
        if (!await confirm('取消此订单？', order.out_trade_no, '取消订单')) return;
        await api.cancelOrder(order.order_id); set(old => ({ ...old, status: 'CANCELLED' }));
      })}>取消订单</Btn><Btn busy={pending === 'verify'} disabled={!!pending} onClick={() => void run('verify', async () => {
        const next = await api.verifyOrder(order.out_trade_no); merge(next);
        if (next.status === 'PENDING') notify('暂未确认收款');
      })}>我已支付，立即核验</Btn></div>}
    </div>
  </Modal>;
}

function Checkout({ opened }: { opened: (order: PaymentOrderResult) => void }) {
  const checkout = useResource('checkout', api.checkoutInfo);
  const [input, setAmount] = useState('50'), [choice, setChoice] = useState('');
  const { pending, run } = useAction();
  const data = checkout.data, methods = Object.entries(data?.methods ?? {});
  const key = methods.find(([k]) => k === choice)?.[0] ?? methods[0]?.[0];
  const method = key ? data?.methods[key] : null;
  const amount = Number(input), fee = round2(amount * (data?.recharge_fee_rate ?? 0) / 100), total = round2(amount + fee);
  const min = Math.max(data?.global_min || 0, method?.single_min || 0);
  const max = Math.min(...[data?.global_max, method?.single_max].filter((n): n is number => typeof n === 'number' && n > 0));
  const valid = /^\d+(\.\d{1,2})?$/.test(input) && Number.isFinite(total) && amount > 0 && amount >= min && amount <= max;
  return <section className="card recharge-panel"><Section title="在线充值" />
    {checkout.error && <Notice retry={checkout.reload}>无法获取充值配置。</Notice>}
    {!data && checkout.loading && <Skeleton />}
    {data && <><Choices className="recharge-options" label="充值面额" items={presets} value={input} change={setAmount} />
      <Field label="自定义金额（¥）" hint={min > 0 || Number.isFinite(max) ? `单笔限额：${[min > 0 && `${money(min)} 起`, Number.isFinite(max) && `最高 ${money(max)}`].filter(Boolean).join('，')}` : undefined}><input type="number" min={min} max={Number.isFinite(max) ? max : undefined} step="0.01" value={input} onChange={e => setAmount(e.target.value)} /></Field>
      <Choices className="recharge-options" label="支付方式" items={methods.map(([k,m]) => [k, methodName(m.payment_type || k)])} value={key ?? ''} change={setChoice} />
      <dl className="recharge-summary"><div><dt>充值金额</dt><dd>{money(amount)}</dd></div><div><dt>手续费（{data.recharge_fee_rate}%）</dt><dd>{money(fee)}</dd></div><div><dt>实付金额</dt><dd><strong>{money(total)}</strong></dd></div><div><dt>预计到账</dt><dd>{credits(round2(amount * (data.balance_recharge_multiplier ?? 1)))}</dd></div></dl>
      {data.recharge_bonus_notice && <small>{data.recharge_bonus_notice}</small>}
      {data.balance_disabled || !method ? <Notice>{data.balance_disabled ? '当前暂停余额充值。' : '暂无可用支付方式。'}</Notice> : null}
      <Btn kind="primary" busy={!!pending} disabled={!method || !valid || data.balance_disabled || !!checkout.error} onClick={() => void run('create', async () => {
        if (method && key) opened(await api.createOrder({ amount, payment_type: method.payment_type || key, order_type: 'balance' }));
      })}>确认充值 {money(total)}</Btn>
    </>}
  </section>;
}

function Redeem() {
  const [code, setCode] = useState('');
  const history = useResource('recent-redemptions', signal => api.redeemHistory({}, signal));
  const { pending, run } = useAction(), { notify } = useFeedback(), { account } = useStudio();
  return <section className="card recharge-panel"><Section title="兑换码充值" />
    <form className="stack" onSubmit={e => { e.preventDefault(); if (code.trim()) void run('redeem', async () => {
      await api.redeem(code.trim()); setCode(''); account.reload(); history.reload(); notify('兑换成功');
    }); }}><Field label="兑换码"><input autoComplete="off" spellCheck={false} placeholder="输入兑换码（区分大小写）" value={code} onChange={e => setCode(e.target.value)} /></Field><Btn type="submit" kind="primary" disabled={!code.trim()} busy={!!pending}>立即兑换</Btn></form>
    <h3>最近兑换记录</h3>
    {history.error && <Notice retry={history.reload}>无法加载兑换记录。</Notice>}
    {history.loading && !history.data && <Skeleton rows={1} />}
    {!!history.data?.items.length && <Table heads={['类型', '数值', '时间']}>{history.data.items.slice(0,5).map(r => <tr key={r.id}><td>{redeemTypeLabels.get(r.type) ?? (r.type || '其他')}</td><td>{r.value}</td><td>{time(r.used_at || r.created_at, true)}</td></tr>)}</Table>}
    {history.data?.items.length === 0 && <p className="muted">暂无兑换记录</p>}
  </section>;
}

function AccountRecharge() {
  const s = useStudio(), { notify, confirm } = useFeedback(), { pending, run } = useAction();
  const [active, setActive] = useState<PaymentOrderResult | null>(null);
  const [status, setStatus] = useState<NonNullable<PaymentOrdersQuery['status']> | ''>(''), [page, setPage] = useState(1);
  const orders = useResource(`orders:${status}:${page}`, signal => api.orders({ page, status: status || undefined }, signal));
  return <div className="stack recharge-view">
    <div className="card spread recharge-strip"><Metric label="当前余额" value={credits(s.session?.account?.balance)} /><small>1 CNY = 1 credit</small><div className="actions"><IconBtn label="刷新余额" icon={RefreshCw} disabled={s.account.loading} onClick={s.account.reload} /><ExternalButton url={purchase} label="官网充值页" /></div></div>
    {s.account.error && <Notice retry={s.account.reload}>余额刷新失败。</Notice>}
    <div className="group-grid"><Checkout opened={o => { setActive(o); orders.reload(); }} /><Redeem /></div>
    <section className="card recharge-panel"><Section title="充值订单记录" actions={<IconBtn label="刷新订单" icon={RefreshCw} onClick={orders.reload} />} />
      <Choices className="recharge-options" label="订单状态" items={filters} value={status} change={v => { setStatus(v); setPage(1); }} />
      {orders.error && <Notice retry={orders.reload}>无法加载订单。</Notice>}
      {orders.loading && !orders.data && <Skeleton />}
      {orders.data && <><Table heads={['订单编号', '金额', '支付方式', '状态', '创建时间', '操作']}>{orders.data.items.map(o => <tr key={o.id}>
        <td><code>{o.out_trade_no}</code></td><td>{money(o.pay_amount)}</td><td>{methodName(o.payment_type)}</td><td><Badge tone={paid(o.status) ? 'good' : 'muted'}>{states[o.status] ?? '未知状态'}</Badge></td><td>{time(o.created_at, true)}</td>
        <td>{o.status === 'PENDING' ? <div className="actions"><Btn kind="ghost" disabled={!!pending} onClick={() => void run('open', async () => { const detail = await api.order(o.id); setActive({ ...detail, pay_url: detail.pay_url ?? o.pay_url, qr_code: detail.qr_code ?? o.qr_code }); })}>支付</Btn><Btn kind="ghost" disabled={!!pending} onClick={() => void run('verify', async () => { const next = await api.verifyOrder(o.out_trade_no); setActive(next); orders.reload(); })}>核验</Btn><Btn kind="ghost" disabled={!!pending} onClick={() => void run('cancel', async () => { if (await confirm('取消此订单？', o.out_trade_no, '取消订单')) { await api.cancelOrder(o.id); orders.reload(); notify('订单已取消'); } })}>取消</Btn></div> : '—'}</td></tr>)}
        {!orders.data.items.length && <tr><td colSpan={6} className="muted">暂无充值订单</td></tr>}
      </Table>{(orders.data.pages > 1 || page > 1) && <div className="actions end"><Btn disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Btn><span>{page} / {orders.data.pages}</span><Btn disabled={page >= orders.data.pages} onClick={() => setPage(page + 1)}>下一页</Btn></div>}</>}
    </section>
    {active && <PaymentModal key={active.order_id} initial={active} close={() => setActive(null)} reload={orders.reload} />}
  </div>;
}

export default function RechargeView() {
  const { session } = useStudio();
  return session?.authenticated ? <AccountRecharge /> : <div className="stack"><LoginGate title="登录 PhuketAI 进行余额充值、兑换码充值与订单查询" /><div className="actions end"><ExternalButton url={purchase} label="前往官网充值" /></div></div>;
}
