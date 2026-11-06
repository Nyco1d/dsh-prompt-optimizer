/**
 * 模式注册表
 *
 * 内置模板在 ./templates/builtin.js（原创实现），用户可在
 * ~/.dsh/prompt-optimizer.json 的 customModes 里追加自己的模板。
 * 官方模板（AGPL）不在仓库里，运行时从本机 PromptOptimizer 的 app.asar 读取，
 * 见 ./templates/official.js。
 * 本文件只负责合并与查找，不含任何提示词正文。
 */

import { BUILTIN_MODES, normalizeCustomMode } from './templates/builtin.js'
import { readOfficialSystem } from './templates/official.js'

const SYSTEM_ROLE_LABEL = { user: '用户', assistant: '助手', system: '系统' }

/** 当前默认模式 id（沿用旧值，已存设置不受影响） */
export const DEFAULT_MODE = 'context-message-optimize'

/** 内置模式（兼容旧引用） */
export const MODES = BUILTIN_MODES

/**
 * 合并内置 + 官方（运行时读取）+ 自定义模板。
 * 自定义 id 与前面的冲突时以先出现的为准（避免用户误覆盖默认行为）。
 *
 * 每项带 source 标记，让前端能区分来源：只有 'custom' 的项可编辑、可删。
 */
export function mergeModes(customModes) {
  const list = BUILTIN_MODES.map((m) => ({ ...m, source: 'builtin' }))

  const official = readOfficialSystem()
  if (official) {
    list.push({
      id: 'official-general-optimize',
      name: '官方模板（对照）',
      description:
        'linshenkx/prompt-optimizer 的 general-optimize，运行时从本机安装目录读取，仅供对照；不随本插件分发',
      system: official,
      // 官方模板把「请基于以上模板，优化并扩展以下 prompt」写在 system 末尾，
      // 原文直接作为 user 消息接在后面，不做额外包裹，保证对照公平。
      buildUser: (text) => text,
      source: 'official',
    })
  }

  if (Array.isArray(customModes)) {
    customModes.forEach((raw, index) => {
      const mode = normalizeCustomMode(raw, index)
      if (mode && !list.some((item) => item.id === mode.id)) list.push({ ...mode, source: 'custom' })
    })
  }
  return list
}

export function findMode(id, customModes) {
  const list = mergeModes(customModes)
  return list.find((mode) => mode.id === id) ?? list[0]
}

/**
 * 迭代模式：在上一版基础上按指令修改，而不是从头重写。
 * 用户点「再专业一点」这类改法走这里，不换优化模式。
 */
export const ITERATE_SYSTEM = `你在修改一份已经优化过的提示词。

用户会给你三样东西：这份提示词的原始诉求、当前这一版、以及一条修改指令。

规则：
- 只是按指令改动，不要推翻重来。没有被指令波及的部分保持原样。
- 指令可能是加东西（例如「再专业一点」「补上异常处理」），也可能是减东西（例如「太长，砍一半」「去掉示例」）。
- 改动后仍然要满足原始诉求，不能为了执行指令把原诉求丢了。
- 输出只给修改后的完整提示词，不要解释改了什么、不要加开场白、不要用代码块包裹。
- 保持原来的长度量级，除非指令明确要求变长或变短。`

export function buildIterateUser(original, previous, instruction) {
  return [
    '# 原始诉求',
    original,
    '',
    '# 当前这一版',
    previous,
    '',
    '# 修改指令',
    instruction,
    '',
    '按指令修改上面这一版，直接输出修改后的完整内容：',
  ].join('\n')
}

/** 去掉模型有时自带的包裹：前后空白、``` 围栏、"优化后：" 前缀 */
export function normalizeOutput(raw) {
  let text = String(raw ?? '').trim()
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/
  const m = text.match(fence)
  if (m) text = m[1].trim()
  text = text.replace(/^(优化后的?(消息|提示词|prompt)?[：:]\s*)/i, '')
  return text.trim()
}

export { SYSTEM_ROLE_LABEL }
