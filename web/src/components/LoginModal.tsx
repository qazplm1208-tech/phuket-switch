import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ExternalLink, Eye, EyeOff, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { PHUKET_BASE_URL } from '@shared/constants';
import { api } from '../api/client';
import { Btn, Choices, Field, IconBtn, Modal, Notice } from './ui';
import { useStudio } from '../lib/studio';
import { useFeedback } from '../lib/feedback';
import { messageOf } from '../lib/resource';

type LoginMode = 'password' | 'token';
type TwoFactorState = { tempToken: string; maskedEmail: string };

const modes = [
  ['password', '邮箱密码登录'],
  ['token', 'Token 登录'],
] as const;

export default function LoginModal() {
  const { setLogin, sessionChanged, baseUrl } = useStudio();
  const { notify } = useFeedback();
  const [action, setAction] = useState<'form' | 'web' | null>(null);
  const busy = action !== null;
  const webLogin = window.phuketDesktop?.webLogin;
  const [error, setError] = useState('');
  const [mode, setMode] = useState<LoginMode>('password');
  const [showPassword, setShowPassword] = useState(false);
  const [twoFactor, setTwoFactor] = useState<TwoFactorState | null>(null);
  const secret = useRef<HTMLInputElement>(null);

  function changeMode(next: LoginMode) {
    setMode(next);
    setTwoFactor(null);
    setError('');
  }

  async function openPhuketLogin() {
    const href = `${PHUKET_BASE_URL}/login`;
    try {
      if (window.phuketDesktop?.openExternal) await window.phuketDesktop.openExternal(href);
      else window.open(href, '_blank', 'noopener');
    } catch { setError(`无法打开浏览器，请手动访问 ${href}。`); }
  }

  function returnToLogin() {
    setTwoFactor(null);
    setError('');
  }

  function complete(result: Awaited<ReturnType<typeof api.login>>) {
    if (!result.authenticated) throw new Error('服务器未建立登录会话。');
    sessionChanged(result);
    notify('已登录 PhuketAI', result.account?.email || result.account?.username);
  }

  async function loginInWindow() {
    if (!webLogin || busy) return;
    setAction('web'); setError('');
    try {
      const result = await webLogin();
      if (result.cancelled) return;
      if (!result.token) throw new Error('未取得网页登录会话，请重试。');
      complete(await api.login({ token: result.token, refreshToken: result.refreshToken }));
    } catch (err) { setError(messageOf(err)); }
    finally { setAction(null); }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    setAction('form');
    setError('');
    try {
      const result = twoFactor
        ? await api.login({ tempToken: twoFactor.tempToken, totpCode: String(form.get('totpCode') ?? '').trim() })
        : mode === 'token'
          ? await api.login({ token: String(form.get('token') ?? '').trim() })
          : await api.login({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? ''), acceptAgreement: true });
      if (result.requires2fa && result.tempToken) {
        setTwoFactor({ tempToken: result.tempToken, maskedEmail: result.maskedEmail || String(form.get('email') ?? '') });
        return;
      }
      complete(result);
    } catch (err) {
      setError(messageOf(err));
      if (!twoFactor && mode === 'password') secret.current?.focus();
    } finally {
      setAction(null);
    }
  }

  const webButton = webLogin && <Btn icon={ExternalLink} busy={action === 'web'} disabled={busy} onClick={() => void loginInWindow()}>网页窗口登录</Btn>;
  const failureNotice = error && <Notice tone="bad">{error} {webButton}</Notice>;

  return (
    <Modal title="登录 PhuketAI" close={() => setLogin(false)} busy={busy}>
      <div className="login-target">
        <KeyRound size={21} />
        <code>{baseUrl}</code>
        <ShieldCheck size={16} />
      </div>
      <form onSubmit={submit} className="form-stack" autoComplete="off">
        <Choices label="登录方式" items={modes} value={twoFactor ? 'password' : mode} change={changeMode} disabled={busy || !!twoFactor} />
        {twoFactor ? (
          <>
            <div className="dialog-copy">已向绑定设备请求 6 位动态验证码（{twoFactor.maskedEmail}）</div>
            <Field label="动态验证码" hint="请输入身份验证器中的 6 位验证码。">
              <input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoFocus required />
            </Field>
            {failureNotice}
            <div className="modal-foot">
              <Btn onClick={returnToLogin} disabled={busy} icon={ArrowLeft}>返回重新登录</Btn>
              <Btn disabled={busy} busy={action === 'form'} type="submit" kind="primary" icon={ShieldCheck}>确认验证</Btn>
            </div>
          </>
        ) : mode === 'token' ? (
          <>
            <div className="dialog-copy">适用于 LinuxDo、GitHub、Google 等第三方登录账号：请在浏览器打开 <code>{PHUKET_BASE_URL}</code> 登录后，从控制台或开发者工具的 <code>localStorage.auth_token</code> 复制 JWT Token 粘贴到这里。Token 不是以 <code>sk-</code> 开头的 API 密钥。</div>
            <Btn kind="ghost" icon={ExternalLink} onClick={() => void openPhuketLogin()} disabled={busy}>在浏览器打开 PhuketAI</Btn>
            <Field label="Token">
              <input name="token" type="text" autoComplete="off" autoFocus required />
            </Field>
            {failureNotice}
            <div className="modal-foot">
              <Btn onClick={() => setLogin(false)} disabled={busy}>取消</Btn>
              <Btn disabled={busy} busy={action === 'form'} type="submit" kind="primary" icon={LogIn}>登录</Btn>
            </div>
          </>
        ) : (
          <>
            <Field label="邮箱">
              <input required autoFocus name="email" type="text" autoComplete="username" placeholder="name@example.com" />
            </Field>
            <Field label="密码" hint="密码仅用于本次登录，不保存在工作台。">
              <div className="inline">
                <input ref={secret} className="grow" name="password" type={showPassword ? 'text' : 'password'} autoComplete="off" required />
                <IconBtn type="button" icon={showPassword ? EyeOff : Eye} label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((value) => !value)} />
              </div>
            </Field>
            <small>登录即代表同意 PhuketAI 服务条款与使用规范（未确认最新协议的账号将自动完成协议确认）。</small>
            {webLogin && <small>网页验证由你在官网完成；本机会保存登录会话并自动续期，退出账号后清除。</small>}
            {failureNotice}
            <div className="modal-foot">
              <Btn onClick={() => setLogin(false)} disabled={busy}>取消</Btn>
              {!error && webButton}
              <Btn disabled={busy} busy={action === 'form'} type="submit" kind="primary" icon={LogIn}>登录</Btn>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
