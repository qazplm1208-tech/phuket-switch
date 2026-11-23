import { execFileSync } from 'node:child_process';
import { conflict } from './common.js';

const native = () => process.platform === 'win32' && process.env.PHUKET_SWITCH_USER_HOME === undefined;
function userEnv(script: string, key?: string) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script], {
      timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      env: key === undefined ? process.env : { ...process.env, PHUKET_ASTRA_VALUE: key },
    }).trim();
  } catch { throw conflict('Cannot access the Windows user environment.'); }
}
export function readAstraUserEnvKey(): string | null {
  if (!native()) return process.env.ASTRA_API_KEY || null;
  return userEnv("[Environment]::GetEnvironmentVariable('ASTRA_API_KEY','User')") || null;
}
export const hasAstraUserEnvKey = () => !!readAstraUserEnvKey();
export function writeAstraUserEnvKey(key: string | null) {
  if (!native()) return;
  userEnv("[Environment]::SetEnvironmentVariable('ASTRA_API_KEY',$env:PHUKET_ASTRA_VALUE,'User')", key ?? '');
}
