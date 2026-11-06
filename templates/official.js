/**
 * 官方模板读取器（运行时从本机 PromptOptimizer 安装目录读取）
 *
 * 为什么不用「把官方模板复制进仓库」：
 *   linshenkx/prompt-optimizer 是 AGPL-3.0-only，它的提示词文本不能随本插件分发。
 *   本文件不含任何官方文本，只在运行时从用户自己机器上的 app.asar 里读出来用。
 *   读不到（没装 / 路径变了 / asar 结构变了 / 没权限）就返回 null，调用方自动隐藏这个模式。
 *
 * 一个必须绕过的问题：DSH 是 Electron 应用，它的 fs 被 asar 补丁接管。
 *   直接 fs.readFileSync('xxx.asar') 不会读原始字节，而是把 asar 当目录去找里面文件，
 *   报错长这样：`ENOENT, not found in C:\...\app.asar`。
 *   所以这里优先用 Electron 的 original-fs（绕过补丁），拿不到就把文件复制成 .bin 再读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

// 绕过 asar 补丁：Electron 环境下 original-fs 能读到原始字节
let rawFs = fs
try {
  if (process.versions && process.versions.electron) rawFs = require_('original-fs')
} catch {
  /* 不是 Electron 或拿不到 original-fs，退回普通 fs */
}

const REL = [
  'node_modules',
  '@prompt-optimizer',
  'core',
  'src',
  'services',
  'template',
  'default-templates',
  'optimize',
  'general-optimize.ts',
]

let overridePath = ''

/** 用户在设置里手动指定 asar 路径时优先用它（不同机器的安装位置可能不同） */
export function setAsarOverride(p) {
  const next = typeof p === 'string' ? p.trim() : ''
  if (next === overridePath) return
  overridePath = next
  cached = undefined
  lastError = ''
}

/**
 * 候选路径。
 * DSH Host 进程的环境变量未必和终端一致（比如 LOCALAPPDATA 被改过），
 * 所以一次列出所有合理位置，逐个试，而不是赌一个。
 */
function candidates() {
  const out = []
  if (overridePath) out.push(overridePath)
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'PromptOptimizer', 'resources', 'app.asar'))
  }
  if (process.env.USERPROFILE) {
    out.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'PromptOptimizer', 'resources', 'app.asar'))
  }
  out.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PromptOptimizer', 'resources', 'app.asar'))
  return [...new Set(out)]
}

/** 读原始字节：普通 fs 被 asar 补丁拦截时，复制成 .bin 再读（按 size+mtime 缓存） */
function readBytes(file) {
  try {
    return rawFs.readFileSync(file)
  } catch (primaryError) {
    try {
      const dir = path.join(os.tmpdir(), 'dsh-po-asar')
      fs.mkdirSync(dir, { recursive: true })
      const dst = path.join(dir, 'app.bin')
      const meta = dst + '.meta'
      const st = fs.statSync(file)
      const key = `${st.size}-${st.mtimeMs}`
      try {
        if (fs.readFileSync(meta, 'utf8') === key) return fs.readFileSync(dst)
      } catch {
        /* 没有缓存或缓存失效，重新复制 */
      }
      fs.copyFileSync(file, dst)
      fs.writeFileSync(meta, key, 'utf8')
      return fs.readFileSync(dst)
    } catch {
      throw primaryError
    }
  }
}

/** 按 Electron asar 格式取一个文件的内容：header pickle 在前，data 从 8+headerSize 起 */
function readAsarEntry(file, parts) {
  const buf = readBytes(file)
  if (buf.length < 16) return null
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  if (jsonSize <= 0 || 16 + jsonSize > buf.length) return null
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  const dataOffset = 8 + headerPickleSize
  let node = header
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null
    node = node.files[p]
  }
  if (node.offset === undefined || node.size === undefined) return null
  const start = dataOffset + Number(node.offset)
  return buf.subarray(start, start + Number(node.size)).toString('utf8')
}

let cached
let lastError = ''

function load() {
  for (const p of candidates()) {
    try {
      if (!fs.existsSync(p)) {
        lastError = `文件不存在：${p}`
        continue
      }
      const src = readAsarEntry(p, REL)
      if (!src) {
        lastError = `asar 里没找到模板文件：${p}`
        continue
      }
      const m = src.match(/content:\s*`([\s\S]*?)`,\s*\n\s*metadata/)
      if (!m) {
        lastError = `模板源码格式不匹配：${p}`
        continue
      }
      const text = m[1].trim()
      if (text.length <= 200) {
        lastError = `模板太短（${text.length} 字符）：${p}`
        continue
      }
      lastError = ''
      return text
    } catch (e) {
      lastError = `读取失败（${p}）：${e && e.message ? e.message : e}`
    }
  }
  return null
}

/** 返回官方 general-optimize 的 system 文本；拿不到返回 null。结果进程内缓存。 */
export function readOfficialSystem() {
  if (cached !== undefined) return cached
  cached = load()
  return cached
}

/** 供 /prompt-opt/modes 判断是否要列出这个模式 */
export function hasOfficial() {
  return readOfficialSystem() !== null
}

/** 读不到时给个可执行的原因，而不是只返回 null 让人猜 */
export function officialError() {
  readOfficialSystem()
  return lastError
}
