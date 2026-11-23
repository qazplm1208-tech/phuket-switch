import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { APP_VERSION, GITHUB_RELEASES_URL } from '@shared/constants';
import { time } from '../lib/display';
import { useAction, useFeedback } from '../lib/feedback';
import { useStudio } from '../lib/studio';
import { Badge, Btn, Notice, Section, Toggle } from './ui';

const mb = (bytes = 0) => (bytes / 1_000_000).toFixed(1);
export default function SoftwareUpdates() {
  const s = useStudio(), u = s.updateState, desktop = window.phuketDesktop;
  const { pending, run } = useAction(), { confirm } = useFeedback();
  const auto = s.prefs.data?.autoCheckUpdates !== false;
  const check = () => void run('check', s.checkUpdates);
  const releases = () => void run('releases', async () => {
    if (desktop) await desktop.openExternal(GITHUB_RELEASES_URL);
    else window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
  });
  const restart = () => void run('install', async () => {
    if (await confirm('重启并安装更新？', '本地代理会短暂中断。请先完成正在进行的请求。', '重启并安装')) await s.installUpdate();
  });
  return <section className="software-updates" aria-label="软件更新">
    <Section title="软件更新" actions={<Btn icon={ExternalLink} onClick={releases}>GitHub Releases</Btn>} />
    <div className="grouped-list">
      <div className="setting-row update-version">
        <div className="grow inline"><b>当前版本 v{u?.currentVersion || desktop?.appVersion || APP_VERSION}</b>
          <Badge>{u?.mode === 'nsis' ? '安装版 · 支持自动更新' : u?.mode === 'portable' ? '便携版' : 'Web / 开发模式'}</Badge>
        </div>
        <Btn icon={RefreshCw} busy={u?.status === 'checking' || pending === 'check'} onClick={check}
          disabled={!desktop?.updater || !!pending || u?.status === 'downloading' || u?.status === 'downloaded'}>检查更新</Btn>
      </div>
      <div className="setting-row"><b className="grow">启动时自动检查更新</b>
        <Toggle label="启动时自动检查更新" on={auto} disabled={!s.prefs.data || pending === 'save'}
          change={() => void run('save', () => s.saveSettings({ autoCheckUpdates: !auto }))} />
      </div>
    </div>
    {!desktop?.updater && <small>浏览器模式请前往 GitHub Releases 查看最新版本。</small>}
    {u?.status === 'not-available' && <p role="status">当前已是最新版本 <small>上次检查：{time(u.checkedAt, true)}</small></p>}
    {u?.status === 'available' && <div className="update-result">
      <div className="spread"><strong>发现新版本 v{u.latestVersion}</strong>{u.releaseDate && <small>{time(u.releaseDate, true)}</small>}</div>
      {u.releaseName && u.releaseName !== `v${u.latestVersion}` && <p>{u.releaseName}</p>}
      {u.releaseNotes && <pre className="release-notes">{u.releaseNotes}</pre>}
      <Btn kind="primary" icon={Download} busy={pending === 'download'} onClick={() => void run('download', s.downloadUpdate)}>
        {u.mode === 'nsis' ? '下载更新' : !u.downloadUrl ? '查看发布页' : /setup/i.test(u.downloadUrl) ? '下载新版安装包' : '下载新版便携包'}
      </Btn>
    </div>}
    {u?.status === 'downloading' && <div className="update-result">
      <div className="spread"><b>正在下载 v{u.latestVersion}</b><span>{u.progress?.percent ?? 0}%</span></div>
      <progress aria-label="更新下载进度" max={100} value={u.progress?.percent ?? 0} />
      <small>{mb(u.progress?.transferred)} / {mb(u.progress?.total)} MB · {mb(u.progress?.bytesPerSecond)} MB/s</small>
    </div>}
    {u?.status === 'downloaded' && <div className="update-result ready"><strong>v{u.latestVersion} 已下载完成</strong>
      <Btn kind="primary" icon={RotateCw} busy={pending === 'install'} onClick={restart}>立即重启并安装</Btn></div>}
    {u?.status === 'error' && <Notice tone="bad" retry={check}>{u.error} <Btn kind="ghost" icon={ExternalLink} onClick={releases}>打开发布页</Btn></Notice>}
  </section>;
}
