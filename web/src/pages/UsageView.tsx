import { Choices } from '../components/ui';
import { useStudio } from '../lib/studio';
import PhuketUsage from './usage/PhuketUsage';
import ProxyUsage from './usage/ProxyUsage';
import SubagentUsage from './usage/SubagentUsage';
import '../styles/usage.css';

const tabs = [['phuket', 'PhuketAI 账户'], ['proxy', '本地代理'], ['subagent', '子代理']] as const;

export default function UsageView() {
  const s = useStudio();
  const [tab, name] = tabs.find(([id]) => id === s.tab) ?? tabs[0];
  return (
    <div className="usage-view stack page-sections">
      <Choices tabs label="用量来源" items={tabs} value={tab} change={id => s.navigate('/usage', id)} />
      <section role="tabpanel" aria-label={name} className="stack page-sections">
        {tab === 'proxy' ? <ProxyUsage /> : tab === 'subagent' ? <SubagentUsage /> : <PhuketUsage />}
      </section>
    </div>
  );
}
