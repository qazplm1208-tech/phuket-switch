import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { Btn, IconBtn, Modal } from '../components/ui';
import { messageOf } from './resource';
type Toast = { id: number; title: string; detail?: string; error: boolean };
type Question = { title: string; detail: string; label: string; resolve: (v: boolean) => void };
interface Feedback {
  notify: (title: string, detail?: string, error?: boolean) => void;
  confirm: (title: string, detail: string, label?: string) => Promise<boolean>;
}
const Ctx = createContext<Feedback | null>(null);
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [items, set] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<Question | null>(null);
  const timers = useRef(new Map<number, number>());
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    set((old) => old.filter((t) => t.id !== id));
  }, []);
  const notify = useCallback(
    (title: string, detail?: string, error = false) => {
      const id = ++counter.current;
      set((old) => [...old.slice(-3), { id, title, detail, error }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), error ? 8500 : 6200),
      );
    },
    [dismiss],
  );
  const confirm = useCallback(
    (title: string, detail: string, label = '确认') =>
      new Promise<boolean>((resolve) =>
        setAsk((old) => {
          old?.resolve(false);
          return { title, detail, label, resolve };
        }),
      ),
    [],
  );
  const answer = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  return (
    <Ctx.Provider value={{ notify, confirm }}>
      {children}
      <aside className="toast-stack" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div className={'toast ' + (t.error ? 'bad' : 'good')} key={t.id}>
            {t.error ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
            <div>
              <strong>{t.title}</strong>
              {t.detail && <p>{t.detail}</p>}
            </div>
            <IconBtn label="关闭通知" icon={X} onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </aside>
      {ask && (
        <Modal title={ask.title} close={() => answer(false)}>
          <p className="dialog-copy">{ask.detail}</p>
          <div className="modal-foot">
            <Btn autoFocus onClick={() => answer(false)}>
              取消
            </Btn>
            <Btn kind="danger" onClick={() => answer(true)}>
              {ask.label}
            </Btn>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
export function useFeedback() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Missing feedback provider');
  return ctx;
}
export function useAction() {
  const { notify } = useFeedback();
  const lock = useRef(false);
  const [pending, set] = useState('');
  async function run(name: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    set(name);
    try {
      await fn();
    } catch (e) {
      notify('操作未完成', messageOf(e), true);
    } finally {
      lock.current = false;
      set('');
    }
  }
  return { pending, run };
}
export async function copyText(text: string, notify: Feedback['notify']) {
  try {
    await navigator.clipboard.writeText(text);
    notify('已复制到剪贴板');
  } catch {
    notify('复制失败', '请选中文字后手动复制。', true);
  }
}
