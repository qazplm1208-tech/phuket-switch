import { ShieldCheck } from 'lucide-react';
import type { ProviderView } from '@shared/types';
import { api } from '../api/client';
import { useResource } from '../lib/resource';
import { Badge, Empty, Modal, Notice, Skeleton } from './ui';

export function DiffPane({ text, other, after }: { text: string | null; other: string | null; after?: boolean }) {
  const reference = new Set(other?.split('\n') ?? []);
  return (
    <div className="diff-pane">
      <header>{after ? '写入后' : '当前配置'}</header>
      {text == null ? (
        <p>文件不存在</p>
      ) : (
        <pre tabIndex={0}>
          {text.split('\n').map((line, i) => (
            <span
              className={'diff-line ' + (!reference.has(line) ? (after ? 'added' : 'removed') : '')}
              key={i}
            >
              <i className="line-number" aria-hidden="true">
                {i + 1}
              </i>
              <code>{line || ' '}</code>
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
export default function DiffPreviewModal({ provider, close }: { provider: ProviderView; close: () => void }) {
  const r = useResource(provider.id, (s) => api.previewDiff(provider.id, s));
  return (
    <Modal wide title="配置 Diff 预览" close={close}>
      <div className="stack">
        <div className="spread">
          <b>{provider.name}</b>
          <Badge tone="good">
            <ShieldCheck size={12} />
            密钥已脱敏
          </Badge>
        </div>
        {r.loading && !r.data && <Skeleton />}
        {r.error && <Notice retry={r.reload}>{r.error}</Notice>}
        {r.data?.warnings.map((w, i) => (
          <Notice key={i}>{w}</Notice>
        ))}
        {r.data?.files.map((f) => (
          <section className="diff-file" key={f.path}>
            <h3>
              <code>{f.path}</code>
            </h3>
            <div className="diff-grid">
              <DiffPane text={f.before} other={f.after} />
              <DiffPane after text={f.after} other={f.before} />
            </div>
          </section>
        ))}
        {r.data && !r.data.files.length && <Empty title="没有待写入的文件" />}
      </div>
    </Modal>
  );
}
