# Phuket Switch local API v1

[types.ts](./types.ts) defines the route signatures and JSON types. Regenerate the tables with `node scripts/api-contract.mjs` after changing a signature. [constants.ts](./constants.ts) defines runtime defaults.

The loopback management listener serves the UI and the `/api` endpoints below. The separate inference listener honors enabled model routes (exact client/model match before `*`) and otherwise uses the current provider. `/v1/messages` and `/v1/responses` support JSON and SSE. Cross-protocol token counting is a local estimate. Logs contain request metadata, not message contents.

Gemini native inference accepts `/v1beta/models` and the model actions below. `/gemini` and `/antigravity` prefixes pin the client selection. Caller `key` query parameters are removed; only the selected provider's credentials are sent upstream. Model routes do not translate Gemini-native requests.

`PUT /api/routes` replaces the complete rule list and assigns IDs to new rules. Auto-populate preserves existing rules (including disabled ones). Catalog sync backs up changed files and updates only the Codex catalog; takeover is configured separately.

GET inputs are decoded query parameters; other inputs are JSON bodies. `NoBody` means absent, including on a 204 response. Responses are bare JSON, not upstream envelopes. Errors use `ApiErrorResponse`. Phuket key and monitor path IDs are numeric; local IDs are opaque strings. Encode path segments separately.

Upstream PhuketAI: unauthenticated `GET /api/v1/model-plaza` works **without an `Authorization` header**. Never send an `sk-` key to `/api/v1/model-plaza`. The public catalog does not grant group access. Keep account sessions and provider credentials on the server. Key and provider reads use masked views; only new key creation reveals the issued key.

Payment and redemption routes require a Phuket account session. Order IDs are positive integers. List queries accept `page` and `page_size` (defaults: 1 and 20); order filters use uppercase status names. The server fixes the hosted checkout return URL, exposes only credential-free HTTPS payment links, and masks redeem codes in history.

Connection diagnostics return `groupId` and, on failure, `guidance` for the failed stage. A 403 triggers a live account balance and key quota check. An unverified balance is `null`, not zero. The copyable report includes the guidance but no credentials. Creating a replacement key requires a separate, user-initiated request.

Provider creation requires exactly one credential source: `apiKey`, `phuketKeyId` (reuse an active account key), or `autoCreatePhuketKey: true` with `phuketGroupId`. The latter two require a Phuket session and resolve the secret server-side. Provider updates accept at most one source; omit all three to keep the current key. On update, the stored group is used unless a new group is supplied. Both routes return only the masked provider view.

Subagent preview and apply accept `enableChunkCompaction` (default `true`), `compactTriggerPct` (integer 40–95, default 88), and `compactKeepRecentGroups` (integer 0–20, default 2). Disabling model-initiated compaction leaves automatic full compaction and manual session maintenance available.

`AppSettings.autoCheckUpdates` is an optional boolean, defaulting to `true` for new and existing databases. A settings PUT that omits it preserves the saved preference. Only the desktop main process checks GitHub on startup; downloading and restarting are separate user actions.

`directBypass` is off by default. `physical-nic` binds connections and DNS to the selected Windows adapter and fails closed if that route is unavailable. `skip-proxy` skips HTTP proxies but uses normal OS routing (including VPN routes). Loopback URLs are exempt. A probe makes a single unauthenticated HTTP request; HTTP statuses below 500 indicate reachability, not successful API authentication. PUT persists the app setting only. Use Subagent Apply to update installed harnesses.

<!-- Generated route tables -->

## Management

| Method and path | Input | Status | Response |
| --- | --- | --- | --- |
| `GET /api/health` | `NoBody` | 200 | `HealthResponse` |
| `GET /api/network/direct-bypass` | `NoBody` | 200 | `DirectBypassStatus` |
| `PUT /api/network/direct-bypass` | `UpdateDirectBypassRequest` | 200 | `DirectBypassStatus` |
| `POST /api/network/direct-bypass/probe` | `DirectBypassProbeRequest` | 200 | `DirectBypassProbeResult` |
| `GET /api/direct-download` | `NoBody` | 200 | `DirectDownloadStatus` |
| `POST /api/direct-download/preview-diff` | `ApplyDirectDownloadRequest` | 200 | `DirectDownloadDiffPreview` |
| `POST /api/direct-download/apply` | `ApplyDirectDownloadRequest` | 200 | `ApplyDirectDownloadResult` |
| `POST /api/direct-download/remove` | `RemoveDirectDownloadRequest` | 200 | `ApplyDirectDownloadResult` |
| `POST /api/direct-download/test` | `DirectDownloadTestRequest` | 200 | `DirectDownloadTestResult` |
| `GET /api/subagent` | `NoBody` | 200 | `SubagentStatus` |
| `POST /api/subagent/preview-diff` | `ApplySubagentRequest` | 200 | `SubagentDiffPreview` |
| `POST /api/subagent/apply` | `ApplySubagentRequest` | 200 | `ApplySubagentResult` |
| `POST /api/subagent/remove` | `RemoveSubagentRequest` | 200 | `ApplySubagentResult` |
| `POST /api/subagent/test` | `SubagentTestRequest` | 200 | `SubagentTestResult` |
| `GET /api/image-prompt` | `NoBody` | 200 | `ImagePromptStatus` |
| `POST /api/image-prompt/apply` | `ApplyImagePromptRequest` | 200 | `ApplyImagePromptResult` |
| `POST /api/image-prompt/remove` | `RemoveImagePromptRequest` | 200 | `ApplyImagePromptResult` |
| `GET /api/overview` | `NoBody` | 200 | `OverviewResponse` |
| `GET /api/providers` | `ProviderQuery` | 200 | `ProviderView[]` |
| `POST /api/providers` | `CreateProviderRequest` | 201 | `ProviderView` |
| `PUT /api/providers/:id` | `UpdateProviderRequest` | 200 | `ProviderView` |
| `DELETE /api/providers/:id` | `NoBody` | 204 | `NoBody` |
| `POST /api/providers/:id/activate` | `ActivateProviderRequest` | 200 | `ActivateProviderResult` |
| `GET /api/providers/:id/preview-diff` | `NoBody` | 200 | `ConfigDiffPreview` |
| `POST /api/providers/:id/test` | `NoBody` | 200 | `ProviderTestResult` |
| `GET /api/fast-mode` | `NoBody` | 200 | `GptFastConfig` |
| `PUT /api/fast-mode` | `UpdateFastModeRequest` | 200 | `UpdateFastModeResult` |
| `POST /api/fast-mode/setup-ultrafast` | `SetupUltraFastRequest` | 200 | `SetupUltraFastResult` |
| `GET /api/phuket/status` | `NoBody` | 200 | `PhuketAuthStatus` |
| `POST /api/phuket/login` | `PhuketLoginRequest` | 200 | `PhuketAuthStatus` |
| `POST /api/phuket/logout` | `NoBody` | 204 | `NoBody` |
| `GET /api/phuket/account` | `NoBody` | 200 | `PhuketAccount` |
| `GET /api/phuket/payment/checkout-info` | `NoBody` | 200 | `PaymentCheckoutInfo` |
| `POST /api/phuket/payment/orders` | `CreatePaymentOrderRequest` | 201 | `PaymentOrderResult` |
| `GET /api/phuket/payment/orders` | `PaymentOrdersQuery` | 200 | `PaymentOrdersPage` |
| `GET /api/phuket/payment/orders/:id` | `NoBody` | 200 | `PaymentOrderItem` |
| `POST /api/phuket/payment/orders/:id/cancel` | `NoBody` | 200 | `{ ok: true }` |
| `POST /api/phuket/payment/orders/verify` | `VerifyPaymentOrderRequest` | 200 | `PaymentOrderItem` |
| `POST /api/phuket/redeem` | `RedeemRequest` | 200 | `RedeemResult` |
| `GET /api/phuket/redeem/history` | `PaymentPageQuery` | 200 | `RedeemHistoryPage` |
| `GET /api/phuket/groups` | `NoBody` | 200 | `PhuketGroupsResponse` |
| `GET /api/phuket/keys` | `PhuketKeysQuery` | 200 | `PhuketKeysPage` |
| `POST /api/phuket/keys` | `CreatePhuketKeyRequest` | 201 | `CreatePhuketKeyResult` |
| `PUT /api/phuket/keys/:id` | `UpdatePhuketKeyRequest` | 200 | `PhuketApiKeyView` |
| `DELETE /api/phuket/keys/:id` | `NoBody` | 204 | `NoBody` |
| `POST /api/phuket/keys/:id/import-provider` | `ImportPhuketKeyRequest` | 201 | `ProviderView` |
| `GET /api/phuket/usage` | `UsageQuery` | 200 | `PhuketUsageResponse` |
| `GET /api/monitors` | `NoBody` | 200 | `ChannelMonitorItem[]` |
| `GET /api/monitors/:id/status` | `NoBody` | 200 | `ChannelMonitorDetail` |
| `POST /api/monitors/probe-local` | `LocalProbeRequest` | 200 | `LocalProbeResult` |
| `GET /api/routes` | `NoBody` | 200 | `ModelRouteRule[]` |
| `PUT /api/routes` | `UpdateModelRoutesRequest` | 200 | `ModelRouteRule[]` |
| `POST /api/routes/auto-populate` | `AutoPopulateRoutesRequest` | 200 | `AutoPopulateRoutesResult` |
| `POST /api/routes/sync-codex-catalog` | `NoBody` | 200 | `SystemApplyResult` |
| `POST /api/routes/clear-codex-catalog` | `NoBody` | 200 | `SystemApplyResult` |
| `GET /api/proxy/status` | `NoBody` | 200 | `ProxyStatus` |
| `PUT /api/proxy/settings` | `ProxySettings` | 200 | `ProxyStatus` |
| `POST /api/proxy/start` | `NoBody` | 200 | `ProxyStatus` |
| `POST /api/proxy/stop` | `NoBody` | 200 | `ProxyStatus` |
| `POST /api/proxy/takeover` | `ProxyTakeoverRequest` | 200 | `ProxyTakeoverResult` |
| `GET /api/proxy/logs` | `ProxyLogsQuery` | 200 | `ProxyLogsPage` |
| `DELETE /api/proxy/logs` | `NoBody` | 204 | `NoBody` |
| `POST /api/lab/speed-compare` | `SpeedCompareRequest` | 200 | `SpeedCompareResult` |
| `GET /api/diagnostics/workbench-models` | `WorkbenchModelsQuery` | 200 | `WorkbenchModelOption[]` |
| `POST /api/diagnostics/connection` | `ConnectionCheckRequest` | 200 | `ConnectionCheckResult` |
| `POST /api/lab/chat-test` | `ChatTestRequest` | 200 | `ChatTestResult` |
| `GET /api/extensions/mcp` | `NoBody` | 200 | `McpServerItem[]` |
| `POST /api/extensions/mcp` | `UpsertMcpRequest` | 200 | `McpServerItem` |
| `DELETE /api/extensions/mcp/:target/:name` | `NoBody` | 204 | `NoBody` |
| `GET /api/extensions/prompts` | `NoBody` | 200 | `PromptPreset[]` |
| `POST /api/extensions/prompts` | `CreatePromptRequest` | 201 | `PromptPreset` |
| `PUT /api/extensions/prompts/:id` | `UpdatePromptRequest` | 200 | `PromptPreset` |
| `DELETE /api/extensions/prompts/:id` | `NoBody` | 204 | `NoBody` |
| `POST /api/extensions/prompts/:id/apply` | `NoBody` | 200 | `SystemApplyResult` |
| `GET /api/extensions/skills` | `NoBody` | 200 | `SkillItem[]` |
| `GET /api/settings` | `NoBody` | 200 | `AppSettings` |
| `PUT /api/settings` | `AppSettings` | 200 | `AppSettings` |
| `GET /api/backups` | `NoBody` | 200 | `ConfigBackupItem[]` |
| `POST /api/backups/:id/restore` | `NoBody` | 200 | `SystemApplyResult` |
| `GET /api/cc-switch/detect` | `NoBody` | 200 | `CcSwitchDetectResult` |
| `POST /api/cc-switch/import` | `CcSwitchImportRequest` | 200 | `CcSwitchImportResult` |

## Inference

| Method and path | Input | Status | Response |
| --- | --- | --- | --- |
| `POST /claude-desktop/v1/messages` | `InferenceJson` | 200 | `InferenceOutput` |
| `POST /claude-desktop/v1/messages/count_tokens` | `InferenceJson` | 200 | `{ input_tokens: number }` |
| `GET /claude-desktop/v1/models` | `NoBody` | 200 | `InferenceJson` |
| `POST /v1/messages` | `InferenceJson` | 200 | `InferenceOutput` |
| `POST /v1/messages/count_tokens` | `InferenceJson` | 200 | `{ input_tokens: number }` |
| `POST /v1/responses` | `InferenceJson` | 200 | `InferenceOutput` |
| `POST /v1/chat/completions` | `InferenceJson` | 200 | `InferenceOutput` |
| `GET /v1/models` | `NoBody` | 200 | `InferenceJson` |
| `GET /v1beta/models` | `NoBody` | 200 | `InferenceJson` |
| `GET /v1beta/models/:model` | `NoBody` | 200 | `InferenceJson` |
| `POST /v1beta/models/:model:generateContent` | `InferenceJson` | 200 | `InferenceJson` |
| `POST /v1beta/models/:model:streamGenerateContent` | `InferenceJson` | 200 | `InferenceOutput` |
| `POST /v1beta/models/:model:countTokens` | `InferenceJson` | 200 | `{ totalTokens: number }` |
