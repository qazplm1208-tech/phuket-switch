import { useCallback, useEffect, useRef, useState } from 'react';

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '请求失败，请重试。';
export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => void;
  replace: (v: T) => void;
}

/** A key change immediately hides the previous identity's data. Late responses cannot overwrite mutations. */
export function useResource<T>(
  key: string | null,
  read: (signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const loader = useRef(read);
  loader.current = read;
  const version = useRef(0);
  const [revision, bump] = useState(0);
  const [state, set] = useState<{ key: string | null; data: T | null; loading: boolean; error: string }>(
    { key: null, data: null, loading: false, error: '' },
  );
  const reload = useCallback(() => {
    bump((x) => x + 1);
  }, []);
  const replace = useCallback(
    (data: T) => {
      ++version.current;
      set({ key, data, loading: false, error: '' });
    },
    [key],
  );
  useEffect(() => {
    if (key === null) {
      set({ key, data: null, loading: false, error: '' });
      return;
    }
    const controller = new AbortController();
    const id = ++version.current;
    set((old) => ({ key, data: old.key === key ? old.data : null, loading: true, error: '' }));
    void loader
      .current(controller.signal)
      .then((data) => {
        if (id === version.current && !controller.signal.aborted)
          set({ key, data, loading: false, error: '' });
      })
      .catch((error) => {
        if (id === version.current && !controller.signal.aborted)
          set((old) => ({ ...old, loading: false, error: messageOf(error) }));
      });
    return () => controller.abort();
  }, [key, revision]);
  return {
    ...(state.key === key ? state : { data: null, loading: key !== null, error: '' }),
    reload,
    replace,
  };
}

export function usePoll(refresh: () => void, ms: number, enabled = true) {
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) fn.current();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
}
