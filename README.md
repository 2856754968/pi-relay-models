# pi-relay-models

[English](README.en.md)

一个用于 [pi](https://github.com/earendil-works/pi-mono) 的混合协议中转站扩展。它自动发现中转站模型，复用 pi 官方模型目录中的元信息，并在同一个 Provider 内按模型选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。

## 功能

- 从兼容端点的 `/models` 自动发现模型 ID。
- 按精确模型 ID 复用 pi 官方名称、推理能力、输入模态、价格、上下文窗口、最大输出、thinking map 和兼容性配置。
- GPT 的 `-fast` 型号没有精确目录条目时，继承去掉该后缀后的 OpenAI 基础模型元信息（其次使用 OpenAI Codex 目录），请求仍保留完整的 `-fast` ID。人工映射优先；继承的价格仅为基础模型参考价，不代表中转站快速线路售价。
- Claude 模型使用 Anthropic Messages，OpenAI 新模型使用 Responses，其他模型默认使用 Chat Completions。
- 未匹配模型使用保守默认元信息，并提供相近的官方候选供人工确认。
- 持久保存人工元信息映射、单模型协议覆盖和排除规则。
- API Key 只通过 pi 的 `/login` 管理，不进入 AI 上下文或扩展配置。
- 可集中配置 Claude/Codex 请求头配置文件。

## 要求

- pi `0.82.1` 或更高版本；官网最新目录可能要求更高版本，请使用满足状态中 `minimumPiVersion` 要求的 pi。当前官网目录要求 pi `1.2.1` 或更高版本。
- Node.js `22.6` 或更高版本
- 中转站提供 OpenAI 或 Anthropic 兼容 API，并能返回模型列表

## 安装

从 npm 安装（推荐）：

```bash
pi install npm:pi-relay-models
```

安装完成后，在 pi 中运行：

```text
/reload
```

不要同时保留手动安装的 `~/.pi/agent/extensions/relay-models/` 副本，否则工具和命令会重复注册。

临时试用而不写入设置：

```bash
pi -e npm:pi-relay-models
```

## 使用

运行交互向导：

```text
/relay-add
```

向导会创建 Provider，并提示执行：

```text
/login <provider-id>
```

请只在 `/login` 的秘密输入框中输入 API Key，不要将 API Key 发送到聊天。登录后可运行：

```text
/relay-sync
/relay-list
```

`/relay-sync` 和 AI 工具的 `sync` 会先强制检查 [pi.dev/models](https://pi.dev/models) 的 [JSON 目录](https://pi.dev/api/models)，再获取中转站实际提供的模型 ID 并匹配元信息。普通模型发现每四小时检查一次官网，使用 ETag 避免重复下载。匹配到的官网数据优先于本机旧目录，包含价格、上下文、输出限制、thinking map 和兼容性配置。

成功获取的目录会缓存到 agent 目录中的 `relay-official-models.json`，重启后可恢复；官网不可用或返回无效数据时沿用最近成功的缓存，没有缓存时使用本机 pi 目录，并在同步结果中显示警告。`status` / `sync` 的 `officialCatalog` 字段提供目录来源、模型数、获取/检查时间、目录修订号 `revision`、最低版本 `minimumPiVersion`、宿主版本 `runtimeVersion` 及警告。宿主版本低于官网要求时会提示升级 pi，同时保留官网最新目录。官网目录用于补全元信息，可选模型仍取决于中转站返回的列表。

删除中转站及其凭据和模型缓存：

```text
/relay-remove <provider-id>
```

交互模式下省略 Provider ID 时可从列表中选择；执行删除前会要求确认。

也可以直接让 AI 添加、删除、同步或检查中转站。扩展注册了 `relay_models` 工具，支持：

| 操作 | 作用 |
| --- | --- |
| `add` | 添加或更新中转站 Provider |
| `remove` | 删除中转站、运行时注册、凭据和模型缓存 |
| `sync` | 刷新模型并匹配官方元信息 |
| `status` | 查看供应商、匹配和路由状态 |
| `map` | 保存人工确认的官方元信息映射 |
| `unmap` | 删除一个或多个官方元信息映射 |
| `protocol` | 覆盖单个模型的协议 |
| `clear` | 清除一个或多个模型的协议覆盖，恢复自动路由 |
| `exclude` | 持久排除一个或多个模型 |
| `include` | 恢复一个或多个已排除模型 |

`unmap`、`clear`、`exclude` 和 `include` 可使用 `remoteModelId` 操作单个模型，或使用 `remoteModelIds` 数组批量操作。`unmap` 只删除官方元信息映射，`clear` 只删除协议覆盖；清除后分别恢复未映射模型的默认元信息或自动协议推断。批量操作只保存一次配置并刷新一次模型列表。

`map` 既支持原有的单模型参数，也支持通过 `mappings` 数组原子化批量映射。顶层 `protocol` 会作为整批默认协议，每个映射也可以单独覆盖：

```json
{
  "action": "map",
  "providerId": "relay-example",
  "protocol": "openai-completions",
  "mappings": [
    {
      "remoteModelId": "model-alias-a",
      "officialProvider": "openai",
      "officialModelId": "gpt-5.4"
    },
    {
      "remoteModelId": "model-alias-b",
      "officialProvider": "anthropic",
      "officialModelId": "claude-sonnet-4-6",
      "protocol": "anthropic-messages"
    }
  ]
}
```

扩展会先验证整批映射和所有官方模型引用；任一项无效时不会写入配置。验证通过后只保存一次并刷新一次。

`map`、`unmap`、`protocol`、`clear`、`exclude` 和 `remove` 属于持久配置变更，AI 工具说明要求在调用前展示所有变更并取得用户明确确认。`unmap` 和 `clear` 需要 `providerId` 及至少一个远端模型 ID；`remove` 只能删除由本扩展管理的中转站。

`status` 和 `sync` 的终端结果会在折叠状态下直接显示供应商摘要及最多 12 个模型，已匹配模型同时显示官方元数据来源和实际协议，未匹配模型显示回退协议。更多模型及完整结构化结果可通过 pi 的工具输出展开快捷键（默认 `Ctrl+O`）查看。其他操作仍默认显示前 8 行并提供展开提示。

状态报告使用 `matchedModels` 和 `unmatchedModels` 数组返回逐模型信息，不再仅返回匹配数量。`matchedModels` 的每一项包含远端模型 ID、官方元数据来源和实际协议；`unmatchedModels` 还包含候选官方模型。发送给模型的工具内容遵循 Pi 的 2000 行/50KB 上限；超限时会保存完整临时 JSON 并在结果中提供路径，终端显式展开仍可查看完整结构。

## 用量统计

更新扩展后，在 pi 中运行 `/reload`，然后使用：

```text
/relay-usage [provider-id]
```

省略 Provider ID 时汇总所有已记录供应商（包括内置供应商、中转站及已删除配置的中转站）；传入 ID 则只看该供应商。当前配置中的中转站显示友好名称。`/session` 只统计当前会话。

命令递归扫描所有项目的 `getAgentDir()/sessions`，并补充当前会话目录、当前会话文件及内存中的会话条目；仅读取本地 JSONL，不联网、不改写历史。默认根目录为 `~/.pi/agent/sessions`，遵循 `PI_CODING_AGENT_DIR`。其他自定义历史路径只能通过当前会话目录或文件发现，不会自动查找以前任意外部目录。

结果按供应商和请求模型 ID（不是 `responseModel`）分组，显示输入、输出、缓存读取/写入 token、这四项之和、记录中的预估美元费用和记录数。`reasoning`、`cacheWrite1h` 属于已有分类的子集，不重复相加。

识别 fork/clone 副本时忽略 `parentId` 并去重；所有分支和压缩前的历史均计入。缺少供应商或模型信息的工具/摘要用量单列为未归属，不会归入筛选的供应商。已删除或缺失的用量无法恢复；预估费用不保证等于中转站账单，旧迁移/复制记录的身份也不总能完全确认。

## Jev 决策模型

Pi 1.5.1 或更高版本中，扩展会将中转实际返回的 `jev-1.14.0`、`jev-latest` 等 Jev ID 注册为同一 Provider 下的 `classifier`，使用 Pi 内置 `typesafe-system-one` 实现，请求 `<Base URL>/systemone`，复用该 Provider 的 `/login` 凭据。Jev 不再出现在聊天模型选择菜单中；`status` 会单列 `classifierModels`，排除规则同样生效。旧版 Pi 保留聊天支持并提示升级，不会把 Jev 当聊天模型。

中转必须实现 System One 接口，仅在 `/models` 中列出 Jev 不代表支持该接口。当前按文本分类注册，64K 上下文沿用 Pi 的 Jev 基准；价格未知时记为零，这不代表服务免费。不从聊天模型目录推断分类器价格或图像能力。

更新本地扩展后执行 `/reload`，再运行 `/relay-sync relay-semi`。通过 codemode 发现模型并调用：

```js
const available = await models.getAvailableOfType("classifier");
const jev = available.find(m => m.provider === "relay-semi" && m.id === "jev-1.14.0");
if (!jev) throw new Error("Jev 尚未发现，请检查登录和模型同步");
const result = await models.classify(jev, {
  state: { message: "服务不可用，请立即处理。" },
  questions: {
    category: {
      type: "choice", instructions: "判断消息类别。",
      criteria: { incident: "故障报告", praise: "正面反馈" },
    },
    urgent: {
      type: "bool", instructions: "是否需要立即处理？",
      criteria: { true: "立即处理", false: "可以等待" },
    },
    severity: {
      type: "score", instructions: "评估严重程度。",
      criteria: ["无问题", "轻微问题", "服务不可用"],
    },
  },
});
if (result.stopReason !== "stop") throw new Error(result.errorMessage);
return result.answers;
```

`choice` 返回选项、各选项的 `probabilities` 和 `confidence`；`bool` 返回成立概率 `probability`；`score` 返回评分 `score` 和置信度 `confidence`，不提供与选择题相同的概率分布。评分标准按数组顺序从 0 编号。codemode 需要已启用；参见 [Pi codemode 文档](https://pi.dev/docs/latest/codemode)。

## 混合协议路由

每个中转站 Provider 同时注册三种 API：

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

匹配到官方目录后，扩展根据官方模型来源选择协议。人工协议覆盖的优先级最高；未匹配模型使用 Provider 的回退协议。

Anthropic 模型会自动移除 Base URL 末尾的 `/v1`，避免 SDK 生成重复的 `/v1/v1/messages` 路径。

### Pi 1.5.1 兼容性

扩展使用 Pi 内置的协议实现，升级 Pi 后会直接获得对应修复，包括 OpenAI Responses 的 `session-id` 会话亲和请求头；无需修改固定请求头配置。

- **Anthropic 消息线程**：Pi 1.5.1 默认只为 `anthropic` Provider 且地址包含 `api.anthropic.com` 的模型启用。扩展会将模型的 Provider 和地址替换成中转配置，普通中转不会仅因匹配到官方模型而自动启用。官方目录中显式声明的 `compat` 字段仍会保留，包括 `supportsMessageThreads`；只有确认网关支持转发 `thread` 时才应启用该能力。
- **禁用工具后的请求**：Pi 1.5.1 在没有启用工具时默认省略 `tools` 字段。旧 LiteLLM 等要求工具历史存在时仍携带该字段的网关，需要模型兼容设置 `compat.requiresToolsWithToolHistory: true`。这是特定网关的配置，不应对所有中转统一启用。
- 上述配置属于 Pi 的模型兼容设置，参见 [Pi 模型配置文档](https://pi.dev/docs/latest/models-configuration)。`relay_models` 工具和 `relay-providers.json` 不提供任意 `compat` 字段编辑功能。

Pi 1.5.1 也支持在终端运行 `pi auth login <provider-id>` 和 `pi auth logout <provider-id>`。登录时使用交互式秘密输入，不要把 API Key 发到聊天中。

## 配置和凭据

扩展使用 pi 的 agent 目录，并维护：

- `relay-providers.json`：供应商 URL、映射、协议覆盖和排除规则，权限为 `0600`
- `models-store.json`：由 pi 管理的模型缓存
- `relay-official-models.json`：扩展缓存的 pi.dev 官方元信息目录
- `auth.json`：由 pi `/login` 管理的凭据

`relay-providers.json` 不包含 API Key。不要提交上述本地文件。

## 请求头配置

固定请求头集中在：

```text
extensions/relay-models/header-profiles.ts
```

默认路由：

- Anthropic Messages 使用 `claude`，上下文窗口达到 1M 时使用 `claudeLongContext`
- OpenAI Chat Completions 使用 `claude`
- OpenAI Responses 使用 `codex`

这些配置用于适配要求特定客户端请求头的中转站。使用前请确认端点条款和兼容性。不要在该文件中加入 Authorization、Cookie 或 API Key。

## 开发

```bash
npm install --include=dev
npm run validate
```

开发依赖锁定 Pi `1.5.1`，最低支持版本仍为 `0.82.1`。CI 对这两个版本分别运行类型检查和全部测试。可在本地临时安装最低版本验证，再恢复锁定依赖：

```bash
npm install --include=dev --no-save --package-lock=false @earendil-works/pi-ai@0.82.1 @earendil-works/pi-coding-agent@0.82.1 @earendil-works/pi-tui@0.82.1
npm run validate
npm ci --include=dev
```

测试使用本机临时 HTTP 服务或模拟 fetch，不访问真实中转站。

## 许可证

[MIT](LICENSE)
