import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppSettings, AppType, GptFastConfig, PhuketAuthStatus } from '@shared/types';
import type { DesktopUpdateState } from '../desktop';
import { DEFAULT_GPT_FAST_CONFIG, GITHUB_RELEASES_URL, PHUKET_BASE_URL } from '@shared/constants';
import { api } from '../api/client';
import { lastWeek, NAV, type PagePath } from './display';
import { messageOf, usePoll, useResource } from './resource';
import { useFeedback } from './feedback';

function locationView() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  return path === '/settings'
    ? { path: '/extensions', tab: 'preferences' }
    : { path, tab: location.hash.slice(1) };
}
function useStudioState() {
  const [{ path, tab }, setLocation] = useState(locationView);
  const [client, setClient] = useState<AppType>('codex');
  const [loginOpen, setLogin] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const { notify } = useFeedback();
  const navigate = useCallback((p: PagePath, sub = '') => {
    const url = p + (sub ? '#' + sub : '');
    if (location.pathname + location.hash !== url) history.pushState(null, '', url);
    setLocation({ path: p, tab: sub });
  }, []);
  const selectClient = (a: AppType) => {
    setClient(a);
    navigate('/');
  };
  useEffect(() => {
    const pop = () => setLocation(locationView());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    document.title = `${NAV.find((n) => n.path === path)?.name ?? '页面未找到'} · Phuket Switch`;
  }, [path]);

  const overview = useResource('overview', api.overview);
  const backups = useResource(path === '/subagent' || (path === '/extensions' && tab === 'backups') ? 'backups' : null, api.backups);
  const prefs = useResource('settings', api.settings);
  const auth = useResource('session', api.auth);
  const providers = useResource('providers', (s) => api.providers(undefined, s));
  const fastResource = useResource('fast', api.fastMode);
  const proxyResource = useResource('proxy', api.proxy);
  const sessionBase = auth.data ?? overview.data?.phuket ?? null;
  const identity = `${epoch}:${sessionBase?.authenticated ? (sessionBase.account?.id ?? 'account') : 'guest'}`;
  const account = useResource(sessionBase?.authenticated ? 'account:' + identity : null, api.account);
  const session =
    sessionBase?.authenticated && account.data ? { ...sessionBase, account: account.data } : sessionBase;
  const usage = useResource(
    path === '/groups' && (tab === 'usage' || tab === 'keys') && session ? 'usage:' + identity : null,
    (s) => api.usage(lastWeek(), s),
  );
  usePoll(
    () => {
      if (!account.loading) account.reload();
    },
    60000,
    !!sessionBase?.authenticated,
  );
  usePoll(
    () => {
      if (!proxyResource.loading) proxyResource.reload();
    },
    path === '/proxy' ? 6000 : 30000,
  );
  usePoll(
    () => {
      if (!auth.loading) auth.reload();
    },
    60000,
    !!sessionBase?.authenticated,
  );
  useEffect(
    () =>
      window.phuketDesktop?.onTrayChange?.((topic) => {
        if (topic === 'updates') { navigate('/extensions', 'preferences'); return; }
        if (topic === 'fast-mode') {
          fastResource.reload();
          prefs.reload();
        }
        if (topic === 'proxy') proxyResource.reload();
        overview.reload();
      }),
    [fastResource.reload, prefs.reload, proxyResource.reload, overview.reload, navigate],
  );
  const bridge = window.phuketDesktop?.updater;
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, received = false;
    const off = bridge.onStateChange(state => { received = true; setUpdateState(state); });
    void bridge.getState().then(state => { if (active && !received) setUpdateState(state); }).catch(() => {});
    return () => { active = false; off(); };
  }, [bridge]);
  async function checkUpdates() { await bridge?.check(); }
  async function downloadUpdate() {
    if (updateState?.status !== 'available') return;
    if (updateState.mode === 'nsis') await bridge?.download();
    else await window.phuketDesktop?.openExternal(updateState.downloadUrl || updateState.releaseUrl || GITHUB_RELEASES_URL);
  }
  async function installUpdate() { await bridge?.install(); }
  const proxy = proxyResource.data ?? overview.data?.proxy ?? null;
  const [pendingFast, setPendingFast] = useState<GptFastConfig | null>(null);
  const storedFast = fastResource.data ?? overview.data?.fastMode ?? prefs.data?.defaultGptFastConfig;
  const fast = pendingFast ?? storedFast ?? DEFAULT_GPT_FAST_CONFIG;
  const [pendingTheme, setPendingTheme] = useState<AppSettings['theme'] | null>(null);
  const preference = pendingTheme ?? prefs.data?.theme ?? 'system';
  const theme = preference === 'dark' ? 'dark' : 'light';
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#16181C' : '#F2F4F7');
    if (prefs.data || pendingTheme)
      void window.phuketDesktop?.setTheme(theme).catch((e) => notify('窗口主题未更新', messageOf(e), true));
  }, [theme, !!prefs.data, notify]);

  // Both PUT routes update the Fast preset. Serialize writes so a theme change can't undo a Fast toggle.
  const writes = useRef(Promise.resolve());
  function serialize<T>(fn: () => Promise<T>) {
    const next = writes.current.then(fn);
    writes.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function saveSettings(patch: Partial<AppSettings>) {
    if (patch.theme) setPendingTheme(patch.theme);
    try {
      await serialize(async () => {
        const current = await api.settings();
        const result = await api.updateSettings({ ...current, ...patch });
        prefs.replace(result);
        fastResource.replace(result.defaultGptFastConfig);
      });
    } finally {
      if (patch.theme) setPendingTheme(null);
    }
  }
  async function saveFast(config: GptFastConfig, applyToCodex = false) {
    setPendingFast(config);
    try {
      return await serialize(async () => {
        const result = await api.updateFastMode({ config, applyToCodex });
        fastResource.replace(result.config);
        prefs.reload();
        if (applyToCodex) overview.reload();
        return result.system;
      });
    } finally {
      setPendingFast(null);
    }
  }
  function sessionChanged(data: PhuketAuthStatus) {
    auth.replace(data);
    setEpoch((v) => v + 1);
    overview.reload();
    setLogin(false);
  }
  function refreshProviders() {
    providers.reload();
    overview.reload();
    usage.reload();
  }
  function refreshAll() {
    [overview, prefs, auth, account, providers, fastResource, proxyResource, usage].forEach((r) =>
      r.reload(),
    );
  }
  return {
    path,
    tab,
    navigate,
    client,
    selectClient,
    loginOpen,
    setLogin,
    identity,
    sessionChanged,
    session,
    overview,
    backups,
    prefs,
    account,
    auth,
    providers,
    usage,
    proxy,
    proxyResource,
    fast,
    fastResource,
    fastReady: !!storedFast,
    fastBusy: !!pendingFast,
    saveFast,
    preference,
    theme,
    updateState, checkUpdates, downloadUpdate, installUpdate,
    saveSettings,
    themeBusy: pendingTheme !== null,
    refreshProviders,
    refreshAll,
    baseUrl: session?.baseUrl || PHUKET_BASE_URL,
  };
}
const Studio = createContext<ReturnType<typeof useStudioState> | null>(null);
export function StudioProvider({ children }: { children: ReactNode }) {
  return <Studio.Provider value={useStudioState()}>{children}</Studio.Provider>;
}
export function useStudio() {
  const s = useContext(Studio);
  if (!s) throw new Error('Missing studio provider');
  return s;
}
