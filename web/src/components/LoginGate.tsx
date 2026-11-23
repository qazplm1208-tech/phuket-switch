import { UserRound } from 'lucide-react';
import { useStudio } from '../lib/studio';
import { Btn, Empty } from './ui';
export default function LoginGate({ title, detail }: { title: string; detail?: string }) {
  const { setLogin } = useStudio();
  return (
    <Empty
      icon={UserRound}
      title={title}
      note={detail}
      action={
        <Btn kind="primary" onClick={() => setLogin(true)}>
          登录
        </Btn>
      }
    />
  );
}
export function SearchInput({
  value,
  change,
  label,
}: {
  value: string;
  change: (s: string) => void;
  label: string;
}) {
  return (
    <input
      className="search-input"
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => change(e.target.value)}
    />
  );
}
