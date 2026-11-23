import { useEffect, useState } from 'react';
import { ArrowDownToLine, Copy, Minus, Moon, Square, Sun, UserRound, X } from 'lucide-react';
import { DEFAULT_PROXY_PORT } from '@shared/constants';
import { APPS, appName, credits } from '../lib/display';
import { useStudio } from '../lib/studio';
import { useAction, useFeedback } from '../lib/feedback';
import { messageOf } from '../lib/resource';
import { Choices, IconBtn } from './ui';
import logo from '../assets/switch.svg';

function WindowButtons() {
  const bridge = window.phuketDesktop;
  const [maximized, setMaximized] = useState(false);
  const { notify } = useFeedback();
  useEffect(() => {
    if (!bridge?.isElectron) return;
    let active = true,
      updated = false;
    const off = bridge.onMaximizeChange((v) => {
      updated = true;
      setMaximized(v);
    });
    void bridge
      .isMaximized()
      .then((v) => {
        if (active && !updated) setMaximized(v);
      })
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, [bridge]);
  if (!bridge?.isElectron) return null;
  const call = (fn: () => Promise<void>) => {
    void fn().catch((e) => notify('窗口操作未完成', messageOf(e), true));
  };
  return (
    <div className="window-buttons">
      <IconBtn label="最小化" icon={Minus} onClick={() => call(bridge.minimize)} />
      <IconBtn
        label={maximized ? '还原窗口' : '最大化'}
        icon={maximized ? Copy : Square}
        onClick={() => call(bridge.toggleMaximize)}
      />
      <IconBtn className="window-close" label="关闭到托盘" icon={X} onClick={() => call(bridge.close)} />
    </div>
  );
}
const clients = APPS.map((a) => [a, appName[a]] as const);
export default function Titlebar({ recharge }: { recharge: () => void }) {
  const s = useStudio(),
    { run } = useAction();
  const account = s.session?.account,
    logged = !!s.session?.authenticated;
  return (
    <header className="titlebar">
      <div className="brand">
        <img src={logo} width="20" height="20" alt="" />
        <span>Phuket Switch</span>
      </div>
      <Choices
        className="client-switch"
        label="客户端供应商"
        items={clients}
        value={s.path === '/' ? s.client : ''}
        change={s.selectClient}
      />
      <div className="title-actions">
        {s.updateState && ['available', 'downloading', 'downloaded'].includes(s.updateState.status) && (
          <button type="button" className="title-pill update-pill" title="查看软件更新" aria-label="查看软件更新"
            onClick={() => s.navigate('/extensions', 'preferences')}>
            <ArrowDownToLine size={13} />
            <span>{s.updateState.status === 'available' ? `新版本 v${s.updateState.latestVersion}` :
              s.updateState.status === 'downloading' ? `下载中 ${s.updateState.progress?.percent ?? 0}%` : '重启更新'}</span>
          </button>
        )}
        <button
          type="button"
          className="title-pill account-pill"
          title={logged ? `${account?.email || 'PhuketAI'} · 余额充值` : '登录 PhuketAI'}
          aria-label={logged ? '余额充值' : '登录 PhuketAI'}
          onClick={() => (logged ? recharge() : s.setLogin(true))}
        >
          {logged ? (
            <>
              <span className="avatar">
                {(account?.username || account?.email || 'P').slice(0, 1).toUpperCase()}
              </span>
              <span className="mono pill-text">{credits(account?.balance)}</span>
            </>
          ) : (
            <>
              <UserRound size={13} />
              <span className="pill-text">登录 PhuketAI</span>
            </>
          )}
        </button>
        <button
          className="title-pill proxy-pill"
          type="button"
          aria-label="查看本地代理"
          title={
            s.proxyResource.error ||
            (s.proxy?.running ? '代理运行中' : s.proxy ? '代理已停止' : '代理状态未知')
          }
          onClick={() => s.navigate('/proxy')}
        >
          <i className={'dot ' + (s.proxy?.running && !s.proxyResource.error ? 'good' : 'idle')} />
          <span className="mono">:{s.proxy?.settings.port ?? DEFAULT_PROXY_PORT}</span>
        </button>
        <IconBtn
          icon={s.theme === 'dark' ? Sun : Moon}
          label={s.theme === 'dark' ? '切换到浅色' : '切换到深色'}
          disabled={s.themeBusy}
          onClick={() =>
            void run('theme', () => s.saveSettings({ theme: s.theme === 'dark' ? 'light' : 'dark' }))
          }
        />
        <WindowButtons />
      </div>
    </header>
  );
}
