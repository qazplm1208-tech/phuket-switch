export interface DesktopUpdateState {
  mode: 'nsis' | 'portable' | 'dev';
  status: 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  checkedAt?: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  error?: string;
}

declare global {
  interface Window {
    phuketDesktop?: {
      isElectron: boolean;
      appVersion: string;
      getVersion(): Promise<string>;
      updater?: {
        getState(): Promise<DesktopUpdateState>;
        check(): Promise<DesktopUpdateState>;
        download(): Promise<DesktopUpdateState>;
        install(): Promise<DesktopUpdateState>;
        onStateChange(cb: (state: DesktopUpdateState) => void): () => void;
      };
      minimize(): Promise<void>;
      toggleMaximize(): Promise<void>;
      close(): Promise<void>;
      isMaximized(): Promise<boolean>;
      onMaximizeChange(cb: (maximized: boolean) => void): () => void;
      onTrayChange?(cb: (topic: 'fast-mode' | 'proxy' | 'updates') => void): () => void;
      setTheme(theme: 'light' | 'dark'): Promise<void>;
      webLogin?(): Promise<{ token?: string; refreshToken?: string; cancelled?: boolean }>;
      openExternal(url: string): Promise<void>;
      quit(): Promise<void>;
    };
  }
}
