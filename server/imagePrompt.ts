import fs from 'node:fs';
import type { ApplyImagePromptRequest, ImagePromptConfig, ImagePromptStatus, ImagePromptTarget, ImagePromptTargetState, PhuketGroup, PhuketApiKeyView, RemoveImagePromptRequest, SystemApplyResult } from '../shared/types.js';
import { allowedGroupModels, canCreateGroupKey, FALLBACK_PHUKET_GROUPS, PHUKET_GPT_BASE_URL, sortModelsNewestFirst } from '../shared/constants.js';
import type { SwitchDb } from './db.js';
import { maskApiKey } from './db.js';
import { bad, now } from './common.js';
import { cliPaths, commitFiles, textFile } from './configFiles.js';
import type { PhuketClient } from './phuketClient.js';

export const IMAGE_PROMPT_START = '<!-- PHUKET_SWITCH_IMAGE_GEN_START -->';
export const IMAGE_PROMPT_END = '<!-- PHUKET_SWITCH_IMAGE_GEN_END -->';
const PLACEHOLDER_KEY = '<写入时自动获取生图分组 API 密钥>';
const targetFiles = (target: ImagePromptTarget) => target === 'codex' ? cliPaths().codexPrompt : cliPaths().claudePrompt;
const targets = ['codex', 'claude'] as const satisfies readonly ImagePromptTarget[];

type StoredImagePrompt = ImagePromptConfig & { apiKey: string };

export function hasImagePromptBlock(existing: string | null | undefined) {
  if (typeof existing !== 'string') return false;
  const start = existing.indexOf(IMAGE_PROMPT_START), end = existing.indexOf(IMAGE_PROMPT_END);
  return start >= 0 && end > start;
}

export function mergeImagePromptBlock(existing: string | null | undefined, block: string) {
  const source = existing ?? '', start = source.indexOf(IMAGE_PROMPT_START), end = source.indexOf(IMAGE_PROMPT_END);
  if (start >= 0 && end > start) return source.slice(0, start) + block + source.slice(end + IMAGE_PROMPT_END.length);
  const trimmed = source.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function stripImagePromptBlock(existing: string | null | undefined) {
  if (typeof existing !== 'string') return existing ?? '';
  const start = existing.indexOf(IMAGE_PROMPT_START), end = existing.indexOf(IMAGE_PROMPT_END);
  if (start < 0 || end <= start) return existing;
  const before = existing.slice(0, start).replace(/[ \t]*\r?\n[ \t]*$/, '').trimEnd();
  const after = existing.slice(end + IMAGE_PROMPT_END.length).replace(/^[ \t]*\r?\n[ \t]*/, '').trimStart();
  if (before && after) return `${before}\n\n${after}${existing.endsWith('\n') ? '\n' : ''}`;
  if (before) return `${before}\n`;
  if (after) return `${after}${existing.endsWith('\n') ? '\n' : ''}`;
  return '';
}

function renderKey(config: ImagePromptConfig & { apiKey?: string }) {
  return config.apiKey || config.maskedKey || PLACEHOLDER_KEY;
}

export function renderImagePromptBlock(config: ImagePromptConfig & { apiKey?: string }) {
  const baseUrl = config.baseUrl.replace(/\/+$/, ''), models = config.models.length ? config.models : [config.defaultModel];
  const modelList = models.map(model => `\`${model}\``).join('、');
  const key = renderKey(config);
  return `${IMAGE_PROMPT_START}
## PhuketAI 生图适配（${config.groupName}）

你可以通过 PhuketAI 的 OpenAI 兼容 Images API 完成图片生成和编辑。收到生图或图片编辑请求时，不要拒绝，也不要只返回文字说明；请在终端运行脚本调用接口，把结果保存为本地文件，再向用户报告文件路径和实际使用的模型。

### 连接信息
- API Base URL：\`${baseUrl}\`
- 文生图：\`POST ${baseUrl}/images/generations\`
- 图生图 / 参考图编辑：\`POST ${baseUrl}/images/edits\`，使用 \`multipart/form-data\`，字段包括 \`model\`、\`prompt\`、\`image\` 或 \`image[]\`、\`size\`、\`quality\`、\`output_format\`
- 模型查询：\`GET ${baseUrl}/models\`
- 生图专用 API 密钥：\`${key}\`，请求头使用 \`Authorization: Bearer ${key}\`；该密钥只用于生图分组，不要用于普通聊天
- 默认生图模型：\`${config.defaultModel}\`
- 可选生图模型：${modelList}

### 使用规则
- \`size\` 可选 \`auto\`、\`1024x1024\`、\`1536x1024\`、\`1024x1536\`
- \`quality\` 可选 \`auto\`、\`low\`、\`medium\`、\`high\`
- \`output_format\` 可选 \`png\`、\`jpeg\`、\`webp\`；\`n\` 使用 \`1\`（默认值）
- 请求超时时间至少 180 秒
- 优先解码响应 \`data[0].b64_json\`；如果返回 \`data[0].url\`，下载该 URL。直接保存为本地文件，例如 \`generated-image.png\`，不要把原始 Base64 打印到聊天中；完成后报告输出文件路径和使用的模型
- 不要在回复、日志或提交的文件中泄露完整 API 密钥

### Python 3 调用示例
下面的零依赖脚本调用文生图接口，同时兼容 Base64 和 URL 响应：

\`\`\`python
import base64
import json
import urllib.request

api_key = ${JSON.stringify(key)}
base_url = ${JSON.stringify(baseUrl)}
payload = {
    "model": ${JSON.stringify(config.defaultModel)},
    "prompt": "在这里替换为用户的图片描述",
    "size": "1024x1024",
    "quality": "auto",
    "output_format": "png",
    "n": 1,
}
request = urllib.request.Request(
    base_url + "/images/generations",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=180) as response:
    result = json.load(response)
item = result["data"][0]
if item.get("b64_json"):
    image_bytes = base64.b64decode(item["b64_json"])
else:
    with urllib.request.urlopen(item["url"], timeout=180) as image_response:
        image_bytes = image_response.read()
with open("generated-image.png", "wb") as image_file:
    image_file.write(image_bytes)
print("generated-image.png")
\`\`\`
${config.customInstructions?.trim() ? `\n### 补充要求\n${config.customInstructions.trim()}\n` : ''}${IMAGE_PROMPT_END}`;
}

function fallbackImageGroup(id?: number): PhuketGroup | null {
  const group = FALLBACK_PHUKET_GROUPS.find(g => g.id === (id ?? 32));
  return group?.adapterCategory === 'image_prompt' ? group : null;
}
function isImageGroup(group: PhuketGroup | null | undefined): group is PhuketGroup { return group?.adapterCategory === 'image_prompt'; }
async function resolveGroup(phuket: PhuketClient, token: string | null, requestedId?: number): Promise<PhuketGroup> {
  let groups: PhuketGroup[] = [];
  try { groups = await phuket.getMergedGroups(token); } catch { /* Offline manual and saved-key mode can use the reference group. */ }
  const group = groups.find(g => g.id === (requestedId ?? 32)) ?? (requestedId === undefined ? groups.find(g => g.adapterCategory === 'image_prompt') : null) ?? fallbackImageGroup(requestedId);
  if (!isImageGroup(group)) throw bad('所选分组不是可用于系统提示词的生图分组。');
  return group;
}
function selectedModels(group: PhuketGroup, stored: StoredImagePrompt, req: ApplyImagePromptRequest) {
  const available = sortModelsNewestFirst(req.models?.length ? req.models : allowedGroupModels(group));
  const models = available.length ? [...new Set(available)] : (stored.models.length ? [...stored.models] : ['gpt-image-2']);
  const requestedDefault = req.defaultModel?.trim();
  const defaultModel = requestedDefault ?? (models.includes(stored.defaultModel) ? stored.defaultModel : models.includes('gpt-image-2') ? 'gpt-image-2' : models[0]);
  if (!models.includes(defaultModel)) models.unshift(defaultModel);
  return { models, defaultModel };
}
function stored(db: SwitchDb) { return db.state('imagePrompt') as StoredImagePrompt; }
function apiKeyForConfig(key: string) { return key ? maskApiKey(key) : ''; }
function publicStatus(db: SwitchDb): ImagePromptStatus {
  const value = stored(db), liveTargets = Object.fromEntries(targets.map(target => {
    const file = targetFiles(target), content = textFile(file);
    return [target, { path: file, exists: fs.existsSync(file), injected: hasImagePromptBlock(content) } satisfies ImagePromptTargetState];
  })) as Record<ImagePromptTarget, ImagePromptTargetState>;
  const config: ImagePromptConfig = {
    enabled: Object.values(liveTargets).some(target => target.injected), groupId: value.groupId, groupName: value.groupName,
    baseUrl: value.baseUrl, defaultModel: value.defaultModel, models: value.models, keyId: value.keyId,
    keyName: value.keyName, maskedKey: apiKeyForConfig(value.apiKey), targets: value.targets,
    ...(value.customInstructions ? { customInstructions: value.customInstructions } : {}), updatedAt: value.updatedAt,
  };
  return { config, liveTargets, previewMarkdown: renderImagePromptBlock({ ...config, apiKey: config.maskedKey || PLACEHOLDER_KEY }) };
}
export function getImagePromptStatus(db: SwitchDb) { return publicStatus(db); }

async function keyFromListed(phuket: PhuketClient, token: string, groupId: number, previous: number | null) {
  const found: PhuketApiKeyView[] = [];
  let seen = 0;
  for (let page = 1; page <= 10000; page++) {
    const batch = await phuket.listKeys(token, page, 100);
    seen += batch.items.length;
    found.push(...batch.items.filter(item => item.status === 'active' && item.group_id === groupId));
    if (!batch.items.length || seen >= batch.total || batch.items.length < 100) break;
  }
  const ordered = [...found].sort((a, b) => Number(b.id === previous) - Number(a.id === previous) || String(b.created_at).localeCompare(String(a.created_at)));
  for (const item of ordered) {
    try { return await phuket.getRawKeyById(token, item.id); } catch { /* Masked or expired candidates are skipped. */ }
  }
  return null;
}
async function acquireKey(db: SwitchDb, phuket: PhuketClient, token: string | null, group: PhuketGroup, req: ApplyImagePromptRequest) {
  const current = stored(db), allowed = db.state('phuketSession')?.account.allowed_groups;
  if (req.apiKey) return { key: req.apiKey, keyId: null, keyName: '手动填写' };
  if (!token) {
    if (current.apiKey) return { key: current.apiKey, keyId: current.keyId, keyName: current.keyName };
    throw bad('请先登录 PhuketAI 账号以自动获取生图分组密钥，或手动填写生图 API 密钥。');
  }
  const t = token;
  if (req.phuketKeyId !== undefined) {
    const result = await phuket.getRawKeyById(t, req.phuketKeyId);
    if (result.item.status !== 'active' || result.item.group_id !== group.id) throw bad('所选密钥不是当前生图分组的有效密钥。');
    return { key: result.key, keyId: result.item.id, keyName: result.item.name };
  }
  if (req.autoCreatePhuketKey) {
    if (!canCreateGroupKey(group, allowed)) throw bad('当前账户无法为生图分组新建密钥。');
    const result = await phuket.createKey(t, { name: 'phuket-switch-image', group_id: group.id });
    return { key: result.key, keyId: result.item.id, keyName: result.item.name };
  }
  const existing = await keyFromListed(phuket, t, group.id, current.keyId);
  if (existing) return { key: existing.key, keyId: existing.item.id, keyName: existing.item.name };
  if (canCreateGroupKey(group, allowed)) {
    try {
      const result = await phuket.createKey(t, { name: 'phuket-switch-image', group_id: group.id });
      return { key: result.key, keyId: result.item.id, keyName: result.item.name };
    } catch { /* A saved key remains a usable offline fallback. */ }
  }
  if (current.apiKey) return { key: current.apiKey, keyId: current.keyId, keyName: current.keyName };
  throw bad('无法自动获取生图分组密钥，请检查账户权限，或手动填写生图 API 密钥。');
}

export async function applyImagePrompt(db: SwitchDb, phuket: PhuketClient, token: string | null, req: ApplyImagePromptRequest): Promise<{ status: ImagePromptStatus; system: SystemApplyResult }> {
  if (!Array.isArray(req.targets) || req.targets.length === 0) throw bad('至少选择一个系统提示词目标。');
  if (req.targets.some(target => !targets.includes(target))) throw bad('系统提示词目标无效。');
  if (req.groupId !== undefined && (!Number.isInteger(req.groupId) || req.groupId <= 0)) throw bad('生图分组无效。');
  const current = stored(db), group = await resolveGroup(phuket, token, req.groupId), { models, defaultModel } = selectedModels(group, current, req);
  const key = await acquireKey(db, phuket, token, group, req);
  const config: StoredImagePrompt = {
    enabled: true, groupId: group.id, groupName: group.name, baseUrl: PHUKET_GPT_BASE_URL, defaultModel, models,
    keyId: key.keyId, keyName: key.keyName, apiKey: key.key, maskedKey: maskApiKey(key.key),
    targets: { codex: req.targets.includes('codex'), claude: req.targets.includes('claude') },
    ...(req.customInstructions?.trim() ? { customInstructions: req.customInstructions.trim() } : {}), updatedAt: now(),
  };
  const block = renderImagePromptBlock(config), plan = new Map<string, string>();
  for (const target of req.targets) {
    const file = targetFiles(target);
    plan.set(file, mergeImagePromptBlock(textFile(file) ?? '', block));
  }
  const primary: 'codex' | 'claude' = req.targets.includes('codex') ? 'codex' : 'claude';
  const system = commitFiles(db, primary, 'Apply image generation prompt', plan);
  const liveTargets = Object.fromEntries(targets.map(target => [target, hasImagePromptBlock(textFile(targetFiles(target)))])) as Record<ImagePromptTarget, boolean>;
  db.setState('imagePrompt', { ...config, targets: liveTargets });
  return { status: publicStatus(db), system };
}

export function removeImagePrompt(db: SwitchDb, req: RemoveImagePromptRequest): { status: ImagePromptStatus; system: SystemApplyResult } {
  const current = stored(db), plan = new Map<string, string>();
  for (const target of req.targets) {
    const file = targetFiles(target), content = textFile(file);
    if (content !== null) plan.set(file, stripImagePromptBlock(content));
  }
  const primary: 'codex' | 'claude' = req.targets.includes('codex') ? 'codex' : 'claude';
  const system = commitFiles(db, primary, 'Remove image generation prompt', plan);
  const live = Object.fromEntries(targets.map(target => [target, hasImagePromptBlock(textFile(targetFiles(target)))])) as Record<ImagePromptTarget, boolean>;
  db.setState('imagePrompt', { ...current, enabled: Object.values(live).some(Boolean), targets: live, updatedAt: now() });
  return { status: publicStatus(db), system };
}

export function imagePromptFile(target: ImagePromptTarget) { return targetFiles(target); }
