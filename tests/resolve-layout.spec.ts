/**
 * 解析通道对 npm/yarn 布局的覆盖测试。
 *
 * 与 forwarded-events.spec.ts 分开，因为这里**不能**桩掉 `node:module`——
 * 要验的正是真实 createRequire 能否在嵌套布局下找到 api-remotes。
 *
 * npm 在版本冲突时会把依赖嵌套装进宿主包自己的 node_modules，此时从入口扁平
 * 解析看不到，只有从宿主包目录出发才可见。这里用临时目录造出三种布局各验一遍。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 每个用例的临时根目录，用完删除。 */
let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  vi.restoreAllMocks()
})

/** 造一个能被 require 的最小 api-remotes 包。 */
function writeRemotesPackage(dir: string): void {
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-api-remotes', version: '0.0.0', main: 'lib/index.js' }))
  writeFileSync(path.join(dir, 'lib', 'index.js'), 'exports.API_REMOTE_FORWARDED_EVENTS = [{ event: "api-session/status", mode: "emit" }]\n')
}

/** 造一个 dsh 入口包，返回它的 bin.js 绝对路径。 */
function writeDshEntry(root: string): string {
  const dshDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
  const bin = path.join(dshDir, 'lib', 'bin.js')
  writeFileSync(bin, '// entry stub\n')
  return bin
}

/** 造一个宿主包（dsh-web-app），返回其包根目录。 */
function writeHostPackage(root: string): string {
  const hostDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  mkdirSync(hostDir, { recursive: true })
  writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '0.0.0' }))
  return hostDir
}

/** 新临时根目录。 */
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pause-layout-'))
  roots.push(root)
  return root
}

/**
 * 在给定 argv[1] 下调用真实注入函数，返回是否注入成功。
 * 每次都重置模块，避免模块级缓存影响。
 */
async function installWithEntry(entry: string): Promise<boolean> {
  vi.resetModules()
  const original = process.argv[1]
  process.argv[1] = entry
  try {
    const mod = await import('../src/forwarded-events.ts')
    return mod.installForwardedEvent()
  } finally {
    process.argv[1] = original
  }
}

describe('installForwardedEvent 布局兼容', () => {
  it('npm 扁平布局：顶层 node_modules 有 api-remotes', async () => {
    const root = makeRoot()
    const bin = writeDshEntry(root)
    writeRemotesPackage(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-api-remotes'))
    expect(await installWithEntry(bin)).toBe(true)
  })

  it('npm 嵌套布局：api-remotes 装在宿主包自己的 node_modules 里', async () => {
    const root = makeRoot()
    const bin = writeDshEntry(root)
    const hostDir = writeHostPackage(root)
    writeRemotesPackage(path.join(hostDir, 'node_modules', '@deepseek-ai', 'dsh-api-remotes'))
    // 顶层刻意不放，确保只有走宿主包目录才解析得到。
    expect(await installWithEntry(bin)).toBe(true)
  })

  it('pnpm 布局：api-remotes 只在 .pnpm/node_modules 里', async () => {
    const root = makeRoot()
    const bin = writeDshEntry(root)
    writeRemotesPackage(path.join(root, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-api-remotes'))
    expect(await installWithEntry(bin)).toBe(true)
  })

  it('三种布局都找不到时返回 false 且不抛错', async () => {
    const root = makeRoot()
    const bin = writeDshEntry(root)
    await expect(installWithEntry(bin)).resolves.toBe(false)
  })
})
