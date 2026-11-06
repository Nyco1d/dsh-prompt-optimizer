/**
 * dsh-prompt-optimizer-nyco1d — Host 半侧
 *
 * 做什么：
 *   1) 暴露 /prompt-opt/run    POST { text, mode, provider?, model? } → { ok, text }
 *   2) 暴露 /prompt-opt/models GET  → 当前可用模型列表
 *   3) 暴露 /prompt-opt/settings GET/POST → 偏好（模式、模型）
 *   4) 用 DSH 自己配置的模型（ctx.llm.stream）跑优化，不接 Prompt Optimizer 的 API key
 *
 * 配置落在 ~/.dsh/prompt-optimizer.json（与 dsh-startup-screen 同款做法：自带 JSON，
 * 不依赖 settings 命名空间，少受版本变更影响）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_MODE, ITERATE_SYSTEM, buildIterateUser, findMode, mergeModes, normalizeOutput } from './modes.js'
import { officialError, setAsarOverride } from './templates/official.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'prompt-optimizer.json')
const HISTORY_FILE = path.join(DSH_HOME, 'prompt-optimizer-history.json')
const HISTORY_LIMIT = 20
const ROUTE_BASE = '/prompt-opt'
const MAX_BODY = 512 * 1024

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return {
      mode: typeof raw.mode === 'string' ? raw.mode : DEFAULT_MODE,
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      customModes: Array.isArray(raw.customModes) ? raw.customModes : [],
      // 手动指定 PromptOptimizer 的 app.asar 路径：自动探测失败时的兜底
      asarPath: typeof raw.asarPath === 'string' ? raw.asarPath : '',
    }
  } catch {
    return { mode: DEFAULT_MODE, provider: '', model: '', customModes: [], asarPath: '' }
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 优化历史：只留最近 HISTORY_LIMIT 条。
 * 历史不是核心功能，任何一环失败都静默降级，不能让插件起不来。
 */
function readHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item) => item && typeof item.original === 'string' && typeof item.optimized === 'string')
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

function writeHistory(list) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    // 先写临时文件再 rename：写到一半中断不会留下半截 JSON
    const tmp = `${HISTORY_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list.slice(0, HISTORY_LIMIT), null, 2), 'utf8')
    fs.renameSync(tmp, HISTORY_FILE)
  } catch {
    /* 历史写失败不影响主流程 */
  }
}

function appendHistory(entry) {
  if (!entry || !entry.optimized) return
  const list = readHistory()
  // 同样的原文 + 同样的结果不重复记（连点两次「再优化一次」只留一条）
  const dup = list.findIndex((item) => item.original === entry.original && item.optimized === entry.optimized)
  if (dup >= 0) list.splice(dup, 1)
  list.unshift({ ...entry, at: Date.now() })
  writeHistory(list)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function resolveSelection(ctx, wanted) {
  if (wanted && typeof wanted.provider === 'string' && typeof wanted.model === 'string') {
    if (wanted.provider && wanted.model) return { provider: wanted.provider, model: wanted.model }
  }
  const store = ctx.get('agentDefaultModel')
  if (store) {
    try {
      const sel = store.currentSelection()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch {
      /* 落回下面的兜底 */
    }
  }
  return null
}

async function runOptimize(ctx, req, res) {
  const body = await readBody(req)
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    sendJson(res, 400, { ok: false, error: '草稿是空的，没有可优化的内容' })
    return
  }
  const saved = readSettings()
  const wantedMode = typeof body.mode === 'string' && body.mode ? body.mode : saved.mode
  const mode = findMode(wantedMode, saved.customModes)
  // 请求里明确指定了模式却找不到 → 报错。
  // 不报错的话 findMode 会静默回退到第一个模式，调用方会以为自己在测 A 模式，其实跑的是 B 模式。
  if (body.mode && mode.id !== body.mode) {
    sendJson(res, 400, { ok: false, error: `未知的优化模式：${body.mode}` })
    return
  }
  // 带指令迭代：不换模式，在上一版基础上按指令改。
  // 两个字段都要有才算迭代，否则按普通优化走，避免前端半传参把结果搞乱。
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
  const previous = typeof body.previous === 'string' ? body.previous : ''
  const iterating = instruction.length > 0 && previous.trim().length > 0
  const selection = resolveSelection(ctx, {
    provider: body.provider ?? saved.provider,
    model: body.model ?? saved.model,
  })
  if (!selection) {
    sendJson(res, 503, { ok: false, error: '没有可用的模型：请在 DSH 里先选好默认模型' })
    return
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let out = ''
  let failure = ''
  try {
    const chunks = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: iterating ? ITERATE_SYSTEM : mode.system,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: iterating ? buildIterateUser(text, previous, instruction) : mode.buildUser(text),
            },
          ],
        },
      ],
      temperature: 0.3,
      signal: controller.signal,
    })
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') out += chunk.text
      else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          failure = reason.failure?.message || (reason.kind === 'aborted' ? '已取消' : '模型调用失败')
        }
      }
    }
  } catch (error) {
    failure = error?.message ? String(error.message) : String(error)
  }

  if (controller.signal.aborted && !out.trim()) {
    sendJson(res, 200, { ok: false, error: '已取消' })
    return
  }
  if (failure && !out.trim()) {
    sendJson(res, 200, { ok: false, error: failure })
    return
  }

  const optimized = normalizeOutput(out)
  if (!optimized) {
    sendJson(res, 200, { ok: false, error: failure || '模型没有返回内容' })
    return
  }
  appendHistory({
    original: text,
    optimized,
    mode: mode.id,
    instruction: iterating ? instruction : '',
  })
  sendJson(res, 200, {
    ok: true,
    text: optimized,
    mode: mode.id,
    provider: selection.provider,
    model: selection.model,
  })
}

function listModes(_req, res) {
  const saved = readSettings()
  sendJson(res, 200, {
    ok: true,
    // 内置与官方模板只下发元信息，不下发 system 正文。
    // 自定义模板例外：用户要能在界面上改它，没有正文就没法编辑。
    // source 用来区分 builtin / official / custom，只有 custom 可编辑、可删。
    modes: mergeModes(saved.customModes).map(({ id, name, description, source, system }) =>
      source === 'custom'
        ? { id, name, description, source, system }
        : { id, name, description, source },
    ),
    // 官方对照模式依赖本机安装的 PromptOptimizer；读不到时把原因带出去，方便排查
    officialError: officialError(),
  })
}

async function listModels(ctx, _req, res) {
  const out = []
  const failures = []
  let providers = []
  try {
    providers = ctx.llm.listProviders()
  } catch (error) {
    sendJson(res, 200, { ok: false, error: String(error?.message || error), models: [] })
    return
  }
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      for (const model of models) {
        out.push({ provider: provider.id, providerName: provider.name, model: model.id, name: model.name })
      }
    } catch (error) {
      failures.push({ provider: provider.id, error: String(error?.message || error) })
    }
  }
  sendJson(res, 200, { ok: failures.length === 0, models: out, failures })
}

function handleSettings(req, res) {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET') {
    sendJson(res, 200, { ok: true, ...readSettings() })
    return
  }
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  readBody(req)
    .then((patch) => {
      const next = {}
      if (typeof patch.mode === 'string') next.mode = patch.mode
      if (typeof patch.provider === 'string') next.provider = patch.provider
      if (typeof patch.model === 'string') next.model = patch.model
      if (Array.isArray(patch.customModes)) next.customModes = patch.customModes
      if (typeof patch.asarPath === 'string') next.asarPath = patch.asarPath
      const saved = writeSettings(next)
      // 路径变了要立刻让官方模板读取器重新探测，否则它还在用上一次的缓存
      setAsarOverride(saved.asarPath)
      sendJson(res, 200, { ok: true, ...saved, officialError: officialError() })
    })
    .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message || error) }))
}

function handleHistory(req, res) {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET') {
    sendJson(res, 200, { ok: true, items: readHistory() })
    return
  }
  if (method === 'DELETE') {
    writeHistory([])
    sendJson(res, 200, { ok: true, items: [] })
    return
  }
  sendJson(res, 405, { ok: false, error: 'method not allowed' })
}

export const inject = ['webServer', 'llm']

export function apply(ctx) {
  // 启动时先应用用户指定的 asar 路径，再做任何探测
  try {
    setAsarOverride(readSettings().asarPath)
  } catch {
    /* 配置读不到就按自动探测走 */
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/run`,
      handler: (req, res) => {
        runOptimize(ctx, req, res).catch((error) => {
          try {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) })
          } catch {
            /* 响应已结束 */
          }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/modes`,
      handler: listModes,
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/models`,
      handler: (req, res) => {
        listModels(ctx, req, res).catch((error) => {
          try {
            sendJson(res, 500, { ok: false, error: String(error?.message || error), models: [] })
          } catch {
            /* 响应已结束 */
          }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/settings`,
      handler: handleSettings,
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/history`,
      handler: handleHistory,
    }),
  )
}
