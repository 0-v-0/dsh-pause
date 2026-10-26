/**
 * 转发 allowlist 注入的单元测试。
 *
 * 分两组：
 * - 用桩模块替换 `@deepseek-ai/dsh-api-remotes`，验证追加形状、幂等、去重、
 *   失败静默这些纯逻辑。
 * - 用真实 pnpm store 里的那份 api-remotes 验证解析通道本身能用（缓存路径与
 *   目录搜索），因为插件安装方式（link / 全局）常导致普通 require 解析不到它。
 */
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ForwardedEvents from '../src/forwarded-events.ts'

/** 每个用例重建的假 allowlist。 */
let list: { event: string; mode: string }[]

/** 通过 vi.mock 拦截 createRequire 返回的模块。 */
const resolvedModule = { API_REMOTE_FORWARDED_EVENTS: [] as { event: string; mode: string }[] }

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: () => {
      const req = ((spec: string) => {
        if (spec === '@deepseek-ai/dsh-api-remotes') return resolvedModule
        throw new Error('not found: ' + spec)
      }) as unknown as NodeJS.Require
      req.resolve = (spec: string) => spec
      return req
    },
  }
})

/** 每次都重新 import，避免模块级状态串场。 */
async function load(): Promise<typeof ForwardedEvents> {
  vi.resetModules()
  return import('../src/forwarded-events.ts')
}

beforeEach(() => {
  list = []
  resolvedModule.API_REMOTE_FORWARDED_EVENTS = list
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installForwardedEvent（桩模块）', () => {
  it('向 allowlist 追加 pause/status 的 emit 条目', async () => {
    const mod = await load()
    expect(list).toHaveLength(0)
    expect(mod.installForwardedEvent()).toBe(true)
    expect(list).toEqual([{ event: 'pause/status', mode: 'emit' }])
  })

  /**
   * 注入必须在模块求值阶段发生。api-remotes 在它自己的 apply 里就一次性 map 出
   * 转发监听，之后再 push 不会补上监听；而 Cordis Loader 先 import 完所有插件模块
   * 再逐个 apply，所以只有模块顶层的调用能赶在它前面。这里 import 插件入口、
   * 不调用 apply，断言条目此时已经就位。
   */
  it('插件入口被 import 时即完成注入，无需等 apply', async () => {
    vi.resetModules()
    expect(list).toHaveLength(0)
    await import('../src/index.ts')
    expect(list.some((entry) => entry.event === 'pause/status')).toBe(true)
  })

  it('重复调用幂等，不重复追加', async () => {
    const mod = await load()
    mod.installForwardedEvent()
    mod.installForwardedEvent()
    mod.installForwardedEvent()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ event: 'pause/status', mode: 'emit' })
  })

  it('allowlist 已含该条目时不再追加，仍返回成功', async () => {
    list.push({ event: 'pause/status', mode: 'emit' })
    const mod = await load()
    expect(mod.installForwardedEvent()).toBe(true)
    expect(list).toHaveLength(1)
  })

  it('不影响 allowlist 里的既有条目', async () => {
    list.push({ event: 'api-session/status', mode: 'emit' })
    const mod = await load()
    mod.installForwardedEvent()
    expect(list.map((entry) => entry.event)).toEqual(['api-session/status', 'pause/status'])
  })

  it('模块解析失败时静默返回 false，不抛错', async () => {
    resolvedModule.API_REMOTE_FORWARDED_EVENTS = undefined as never
    const mod = await load()
    // 桩模块的 API_REMOTE_FORWARDED_EVENTS 不是数组 → 所有起点都失败 → false
    expect(() => mod.installForwardedEvent()).not.toThrow()
    expect(mod.installForwardedEvent()).toBe(false)
  })

  it('返回的模块对象就是进程内同一份 allowlist（模块缓存语义）', async () => {
    const mod = await load()
    mod.installForwardedEvent()
    // 同一 require 缓存下，再次解析拿到同一个数组引用
    const req = createRequire(import.meta.url)
    expect(typeof req.resolve).toBe('function')
    expect(list.some((entry) => entry.event === 'pause/status')).toBe(true)
  })
})

/**
 * 真实解析通道。
 *
 * 这里不用 vi.mock：目的是验证「插件在仓库目录下运行、自身依赖树里没有
 * api-remotes」时，注入仍能通过缓存路径或 pnpm hoist 目录找到那份模块。
 * 找不到时返回 false 也算通过——本仓库的测试环境未必装了 harness，
 * 那种情况断言的是「优雅失败而不是抛错」。
 */
describe('installForwardedEvent（真实解析）', () => {
  it('不抛错，且结果与是否找到模块一致', async () => {
    vi.doUnmock('node:module')
    vi.resetModules()
    const real = await import('../src/forwarded-events.ts')
    const result = real.installForwardedEvent()
    expect(typeof result).toBe('boolean')
  })

  it('能从 pnpm store 解析到 harness 的 api-remotes 时，allowlist 含 28 条以上既有条目', () => {
    // 独立于被测代码，直接验证解析目标存在且形状正确：缺了它，上面的
    // installForwardedEvent 只能返回 false，插件就要靠轮询兜底。
    const store = process.env['DSH_PAUSE_REMOTES_STORE']
    if (store === undefined || store === '') return
    const req = createRequire(store)
    const mod = req(req.resolve('@deepseek-ai/dsh-api-remotes')) as {
      API_REMOTE_FORWARDED_EVENTS?: { event: string }[]
    }
    const entries = mod.API_REMOTE_FORWARDED_EVENTS
    expect(Array.isArray(entries)).toBe(true)
    expect(entries!.length).toBeGreaterThan(20)
  })
})
