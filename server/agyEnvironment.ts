import { execFileSync } from 'node:child_process';
import { conflict, isRecord } from './common.js';

export type AgyEnv = { GEMINI_API_KEY: string | null; GOOGLE_GEMINI_BASE_URL: string | null };
const native = () => process.platform === 'win32' && process.env.PHUKET_SWITCH_USER_HOME === undefined;
export const agyEnvNote = () => process.platform === 'win32'
  ? '请重新打开终端运行 agy；新终端会读取用户环境变量 GEMINI_API_KEY 和 GOOGLE_GEMINI_BASE_URL。'
  : 'agy 不读取 .env。请在启动 agy 的终端配置 GEMINI_API_KEY 和 GOOGLE_GEMINI_BASE_URL，并重新打开终端。';
const readScript = `@{ GEMINI_API_KEY = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY','User'); GOOGLE_GEMINI_BASE_URL = [Environment]::GetEnvironmentVariable('GOOGLE_GEMINI_BASE_URL','User') } | ConvertTo-Json -Compress`;
const writeScript = `[Environment]::SetEnvironmentVariable('GOOGLE_GEMINI_BASE_URL',$env:PHUKET_AGY_URL,'User'); [Environment]::SetEnvironmentVariable('GEMINI_API_KEY',$env:PHUKET_AGY_KEY,'User')`;
function powershell(script: string, values?: AgyEnv) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script], {
      windowsHide: true, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: values ? { ...process.env, PHUKET_AGY_URL: values.GOOGLE_GEMINI_BASE_URL ?? '', PHUKET_AGY_KEY: values.GEMINI_API_KEY ?? '' } : process.env,
    });
  } catch { throw conflict('无法读取或更新 Windows 用户环境变量，请检查权限。'); }
}
export function validAgyEnv(v: unknown): v is AgyEnv {
  return isRecord(v) && [v.GEMINI_API_KEY, v.GOOGLE_GEMINI_BASE_URL].every(value => value === null || typeof value === 'string');
}
// Only live detection uses the short cache. Always take a fresh snapshot before changing the environment.
let cached: { at: number; values: AgyEnv } | undefined;
export function readAgyEnv(forDetection = false): AgyEnv | undefined {
  if (!native()) return undefined;
  if (forDetection && cached && Date.now() - cached.at < 5000) return cached.values;
  const values: unknown = JSON.parse(powershell(readScript));
  if (!validAgyEnv(values)) throw conflict('无法读取 Antigravity 环境变量。');
  cached = { at: Date.now(), values }; return values;
}
export function writeAgyEnv(values: AgyEnv) {
  if (!native()) return;
  cached = undefined;
  powershell(writeScript, values);
}
