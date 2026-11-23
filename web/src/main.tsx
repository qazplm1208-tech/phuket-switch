import { Component, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FeedbackProvider } from './lib/feedback';
import { StudioProvider } from './lib/studio';
import './index.css';
import './styles.css';
import './views.css';
import './responsive.css';
class FaultBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="fault">
        <h1>此视图无法显示</h1>
        <p>请刷新工作台，已保存的配置不受影响。</p>
        <button className="btn primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FaultBoundary>
      <FeedbackProvider>
        <StudioProvider>
          <App />
        </StudioProvider>
      </FeedbackProvider>
    </FaultBoundary>
  </StrictMode>,
);
