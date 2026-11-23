import { Zap } from 'lucide-react';
import { NAV, withFastEnabled } from '../lib/display';
import { useAction } from '../lib/feedback';
import { useStudio } from '../lib/studio';

export default function Sidebar() {
  const s = useStudio(),
    { run } = useAction();
  const fastLabel = s.fastReady && s.fast.speedMode === 'ultrafast' ? 'GPT UltraFast' : 'GPT Fast';
  return (
    <aside className="sidebar">
      <nav aria-label="主导航">
        {NAV.map(({ path, name, icon: Icon }) => (
          <a
            href={path}
            key={path}
            title={name}
            aria-label={name}
            aria-current={s.path === path ? 'page' : undefined}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey) return;
              e.preventDefault();
              s.navigate(path);
            }}
          >
            <Icon size={16} />
            <span>{name}</span>
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={'sidebar-fast ' + (s.fastReady && s.fast.enabled ? 'active' : '')}
          role="switch"
          aria-checked={s.fastReady && s.fast.enabled}
          aria-label={fastLabel}
          title={s.fastReady ? `${fastLabel} ${s.fast.enabled ? '已开启' : '已关闭'}` : '正在读取 Fast 配置'}
          disabled={s.fastBusy || !s.fastReady}
          onClick={() =>
            void run('fast', async () => {
              await s.saveFast(withFastEnabled(s.fast, !s.fast.enabled));
            })
          }
        >
          <Zap size={15} />
          <span>{fastLabel}</span>
          <i className={`toggle gold ${s.fastReady && s.fast.enabled ? 'on' : ''}`} aria-hidden="true">
            <span />
          </i>
        </button>
      </div>
    </aside>
  );
}
