# dsh-prompt-optimizer-nyco1d

在 DeepSeek Harness 的输入框旁放一个魔法棒，一键把草稿改写成更清晰的版本，改完左右对比，你点「采用」才写回输入框。

> Fork / 衍生关系说明见文末「与 Prompt Optimizer 的关系」。本项目**不包含**任何第三方项目的提示词原文。

## 功能

- **一键优化**：点击魔法棒，把当前草稿送去优化，结果在浮层里和原文并排显示
- **不自动覆盖**：只有你点「采用」才写回草稿；另有「再优化一次」「丢弃」
- **两种内置模式**：消息优化（保持一句话的长度）、结构化重写（扩写成角色设定）
- **模型可控**：默认跟随 DSH 当前选中的默认模型，也可以在设置面板里指定任意已配置的模型
- **零配置启动**：不需要任何 API key，走 DSH 自己的模型通道
- **不依赖桌面版**：完全独立运行，不需要本机安装 Prompt Optimizer

## 安装

在 DeepSeek Harness 的插件市场里搜 `prompt-optimizer` 安装，或手动从 GitHub 装：

```sh
# 从 GitHub 仓库安装（会取默认分支最新代码）
dsh plugin --profile <profile> add Nyco1d/dsh-prompt-optimizer

# 或装一个打好的发布包
dsh plugin --profile <profile> add https://github.com/Nyco1d/dsh-prompt-optimizer/releases/download/v0.2.0/dsh-prompt-optimizer-nyco1d-0.2.0.tgz
```

桌面端请在应用内 **设置 → 插件** 里安装，不要用命令行（profile 归应用管理）。

## 使用

| 操作 | 效果 |
|---|---|
| 左键点魔法棒 | 优化当前草稿，弹出左右对比浮层 |
| `Shift` + 左键点魔法棒 | 直接打开设置面板 |
| 右键点魔法棒 | 打开设置面板（模式 / 模型） |

设置面板里可以换优化模式、搜索并指定模型。选择立刻生效，不需要重启。

## 配置

配置存在 `~/.dsh/prompt-optimizer.json`（可用 `DSH_HOME` 改变根目录）。一般不需要手改，设置面板会写它。

### 自定义模板

在 `customModes` 里追加你自己的模板：

```json
{
  "mode": "context-message-optimize",
  "provider": "",
  "model": "",
  "customModes": [
    {
      "id": "my-mode",
      "name": "我的模板",
      "description": "一句话说明这个模板干什么",
      "system": "你负责……（这里写 system prompt）"
    }
  ]
}
```

字段说明：

- `id` 必填且不能与内置模式重名（重名时以内置为准）
- `system` 必填，就是发给模型的 system 消息
- `name` / `description` 只用于界面展示，可省略
- 待优化的文本会连同分隔符一起作为 user 消息发出去，模板里的 `buildUser` 逻辑由插件统一处理

改完文件后在设置面板里重新打开一次即可看到新模式（Host 侧每次请求都会重读配置）。

## 工作原理

```
浏览器（client.js）
  ├─ 挂到 conversation.input.left 的魔法棒按钮
  ├─ 用 slot props 的 useInput 读草稿、inputActions.setDraft 写回
  └─ fetch 到 Host 的 /prompt-opt/*
Host（index.js）
  ├─ ctx.webServer 注册四条 JSON 路由
  └─ ctx.llm.stream 用 DSH 已配置的模型跑优化
```

没有进程外依赖，没有外部服务，没有遥测。

> 改 `templates/builtin.js` 里的模板后**需要重启 DSH** 才生效——Host 侧是静态 import，不做热更新。改 `client.js` 的界面则刷新页面即可。

## 兼容性

- 需要 DeepSeek Harness `>=0.2.0-rc.1`（`engines.dsh` 里声明了，市场会据此判断兼容性）
- Node.js `^22.19.0 || >=24.0.0`

## 与 Prompt Optimizer 的关系

本项目在交互形态上受 [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) 启发——那是桌面端一个做同类事情的应用。

需要说清楚的地方：

- **本项目代码（`index.js` / `client.js` / `modes.js` / `templates/`）是独立编写的，采用 MIT 许可证。**
- **内置的两个模板是独立实现**，目标相同（把粗糙输入改写成可执行的版本），但结构划分、示例策略、措辞均为重新编写。
- linshenkx/prompt-optimizer 使用 **AGPL-3.0-only** 许可证。如果你想在本插件里使用它的官方模板，需要自行从它的发行版中提取并写进上面的 `customModes`——那属于你个人的使用行为，本仓库不分发、也不内嵌那些文本。

如果你就是想要官方模板的效果，推荐直接用原项目，它支持更多模型和更完整的模板体系。

## License

MIT，见 [LICENSE](./LICENSE)。
