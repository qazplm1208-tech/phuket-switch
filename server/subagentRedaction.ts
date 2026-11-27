import { redactRecognizable } from './common.js';
import type { SwitchDb } from './db.js';

export function secrets(db: SwitchDb, extra = '') {
  const session = db.state('phuketSession');
  return [extra, db.state('subagent').apiKey, db.state('imagePrompt').apiKey, session?.token, session?.refreshToken, ...db.providers().map(p => p.apiKey)].filter((s): s is string => !!s).sort((a, b) => b.length - a.length);
}
export function scrub(text: string, keys: string[]) {
  return redactRecognizable(keys.reduce((s, key) => s.replaceAll(key, '[REDACTED]'), text));
}
