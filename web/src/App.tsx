import { lazy, Suspense, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { NAV } from './lib/display';
import { useStudio } from './lib/studio';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import LoginModal from './components/LoginModal';
import { Btn, Empty, Modal, Skeleton } from './components/ui';
import SwitchHub from './pages/SwitchHub';
const Groups = lazy(() => import('./pages/GroupsAndKeys'));
const UsageView = lazy(() => import('./pages/UsageView'));
const Monitors = lazy(() => import('./pages/ChannelMonitor'));
const ProxyView = lazy(() => import('./pages/LocalProxyView'));
const Lab = lazy(() => import('./pages/SpeedLabView'));
const SubagentView = lazy(() => import('./pages/SubagentView'));
const Extensions = lazy(() => import('./pages/ExtensionsAndSettings'));

function Jump({ close }: { close: () => void }) {
  const s = useStudio(),
    [q, set] = useState('');
  const rows = NAV.filter((n) => n.name.includes(q.trim()));
  return (
    <Modal title="前往页面" close={close}>
      <div className="jump">
        <label className="inline">
          <Search size={15} />
          <input
            autoFocus
            type="search"
            aria-label="搜索页面"
            value={q}
            onChange={(e) => set(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && rows[0]) {
                s.navigate(rows[0].path);
                close();
              }
            }}
          />
        </label>
        {rows.map(({ icon: Icon, name, path }) => (
          <Btn
            kind="ghost"
            key={path}
            icon={Icon}
            onClick={() => {
              s.navigate(path);
              close();
            }}
          >
            {name}
          </Btn>
        ))}
        {!rows.length && <p>没有匹配的页面</p>}
      </div>
    </Modal>
  );
}
export default function App() {
  const s = useStudio(),
    [jump, setJump] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'k' &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault();
        setJump(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const name = NAV.find((n) => n.path === s.path)?.name;
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <Titlebar recharge={() => s.navigate('/groups', 'recharge')} />
      <Sidebar />
      <main id="main-content" tabIndex={-1} key={s.path}>
        <div className="page">
          {s.path !== '/' && name && <h1 className="page-title">{name}</h1>}
          <Suspense fallback={<Skeleton rows={3} />}>
            {s.path === '/' ? (
              <SwitchHub key={s.client} />
            ) : s.path === '/groups' ? (
              <Groups key={s.identity} />
            ) : s.path === '/usage' ? (
              <UsageView key={s.identity} />
            ) : s.path === '/monitor' ? (
              <Monitors />
            ) : s.path === '/proxy' ? (
              <ProxyView />
            ) : s.path === '/lab' ? (
              <Lab />
            ) : s.path === '/subagent' ? (
              <SubagentView key={s.identity} />
            ) : s.path === '/extensions' ? (
              <Extensions />
            ) : (
              <Empty title="找不到此页面" action={<Btn onClick={() => s.navigate('/')}>返回供应商</Btn>} />
            )}
          </Suspense>
        </div>
      </main>
      {s.loginOpen && <LoginModal />}
      {jump && <Jump close={() => setJump(false)} />}
    </div>
  );
}
