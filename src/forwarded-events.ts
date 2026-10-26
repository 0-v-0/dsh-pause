/**
 * 把 pause/status 注入 host → browser 的事件转发 allowlist。
 *
 * 背景：host 端 `$events` 推送（`/api/remote.mux` WebSocket）只转发
 * `@deepseek-ai/dsh-api-remotes` 里硬编码的 `API_REMOTE_FORWARDED_EVENTS`。
 * 该数组在 `remoteEventSource(ctx)` 里被一次性 `.map` 成 Cordis 监听，而
 * `remoteEventSource(ctx)` 是 `apply` 里 `ctx.typertGateway.registerRemoteEvents(...)`
 * 的入参——**注册时**就 `source(signal)` 建好流、绑完全部监听，不是每次浏览器
 * 连接时再 map。
 *
 * 由此，在插件 `apply` 里 push 这个数组**为时已晚**：api-remotes 的 apply 早已
 * 跑完、监听早已绑好，新增条目永远不会有监听。
 *
 * 注入因此必须在模块求值阶段完成：Cordis Loader 先把整棵树里每个插件模块
 * `import` 完（求值各自的顶层代码），再逐个调用 `apply`。在本模块被 import
 * 时调用 {@link installForwardedEvent} 一定早于 api-remotes 的 apply，条目会
 * 被那次唯一的 map 收进去，装完即用、卸载后不留残留。
 *
 * ## 怎么找到那个模块
 *
 * `dsh-api-remotes` 属 harness 装配，不在插件自身依赖树里（插件经 link/全局
 * 安装时尤其如此），所以不能用普通的 `require`。按可靠性从高到低尝试：
 *
 * 1. 从 dsh 入口脚本（`process.argv[1]`，即 `.../@deepseek-ai/dsh/lib/bin.js`）
 *    直接 require——pnpm 下 `bin.js` 就住在 store 的 hoist 目录里，普通 Node
 *    解析即可命中。
 * 2. 从 `process.execPath` 向上同理，覆盖 dsh 随 node 一起打包分发的情形。
 * 3. 以 `process.cwd()` 为起点 require，覆盖 cwd 就在 dsh 安装树里的情形。
 * 4. **npm/yarn 布局兜底**：从每个起点向上逐级，在每一层的 `node_modules` 里
 *    找承载它的宿主包（{@link HOST_PACKAGES}），再把宿主包目录当作新起点重新
 *    解析。npm 在版本冲突时会把依赖**嵌套**装进宿主包自己的 `node_modules`，
 *    此时从入口扁平解析看不到，只有从宿主包目录出发才可见。
 *
 * 幂等：同一进程里重复调用不会重复追加；任何解析失败都静默返回 false，
 * 由客户端回退到轮询。
 *
 * @module dsh-pause/forwarded-events
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** 要注入的转发条目：pause/status 以 emit 模式转发。 */
const PAUSE_STATUS_EVENT = 'pause/status'

/** 目标包名。 */
const REMOTES_PACKAGE = '@deepseek-ai/dsh-api-remotes'

/**
 * 可能把 api-remotes 拉进自己依赖树的宿主包。
 *
 * `dsh-web-app` 直接声明 api-remotes（web 装配层），`dsh` 是顶层入口。pnpm 用
 * 单一 hoist 目录暴露它们，npm/yarn 则在版本冲突时把各自依赖嵌套安装在包内。
 */
const HOST_PACKAGES = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh'] as const

/** allowlist 条目形状，只关心 event 字段用于去重。 */
interface ForwardedEventEntry {
  event?: unknown
  mode?: unknown
}

/** api-remotes 模块的最小面，只读它导出的 allowlist。 */
interface ApiRemotesModule {
  API_REMOTE_FORWARDED_EVENTS?: ForwardedEventEntry[]
}

/**
 * 从起点向上逐级找承载 api-remotes 的宿主包目录。
 *
 * 每一层的 `<dir>/node_modules/<host>` 都可能存在：pnpm 只有 hoist 层有，npm
 * 扁平安装时顶层有，版本冲突时则嵌在宿主包内部。返回这些宿主包的 `package.json`
 * 路径（不是目录）——createRequire 以目录为基准时按该目录的父级解析，只有以
 * 包内文件为基准才会先看包自己的 `node_modules`，从而命中嵌套安装。
 * @param start 搜索起点，通常是入口脚本或可执行文件路径。
 * @returns 宿主包 package.json 路径列表，由近及远；一个都没有时为空数组。
 */
function hostPackageAnchors(start: string): string[] {
  const found: string[] = []
  let dir = path.dirname(start)
  for (;;) {
    const nm = path.join(dir, 'node_modules')
    for (const host of HOST_PACKAGES) {
      const manifest = path.join(nm, host, 'package.json')
      if (existsSync(manifest)) found.push(manifest)
    }
    const up = path.dirname(dir)
    if (up === dir) return found
    dir = up
  }
}

/**
 * pnpm virtual store 顶层 hoist 目录：`<root>/node_modules/.pnpm/node_modules`。
 *
 * dsh-api-remotes 属 harness 装配，只以 hoisted 形式暴露在这里；插件自己的
 * 依赖树（含 link 进来的仓库）里没有它，故必须从 dsh 入口或运行时向上找。
 * @param start 搜索起点，通常是入口脚本或可执行文件路径。
 * @returns hoist 目录的绝对路径；找不到返回 null。
 */
function storeHoistNodeModules(start: string): string | null {
  let dir = path.dirname(start)
  for (;;) {
    const nm = path.join(dir, 'node_modules')
    if (existsSync(path.join(nm, '.pnpm', 'node_modules'))) return path.join(nm, '.pnpm', 'node_modules')
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * 候选解析起点，按可靠性排序。
 *
 * `process.argv[1]` 是 dsh 的 bin，从它向上能找到运行时的 node_modules；
 * `process.execPath` 覆盖 dsh 被全局安装、argv 指向别处的情形。每个起点再补上
 * pnpm hoist 目录与宿主包目录，后者负责 npm/yarn 的嵌套布局。
 * @returns 去重后的起点列表；`undefined` 项已滤除。
 */
function resolveBases(): string[] {
  const seen = new Set<string>()
  const bases: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    if (seen.has(value)) return
    seen.add(value)
    bases.push(value)
  }
  for (const entry of [process.argv[1], process.execPath]) {
    if (typeof entry !== 'string' || entry === '') continue
    add(entry)
    const hoist = storeHoistNodeModules(entry)
    if (hoist !== null) add(hoist)
    for (const hostAnchor of hostPackageAnchors(entry)) add(hostAnchor)
  }
  try {
    add(process.cwd())
  } catch {
    /* 极端环境下 cwd 不可读，忽略 */
  }
  return bases
}

/** 把一个模块对象里的 allowlist 补上 pause/status；返回是否确认就位。 */
function patchModule(mod: unknown): boolean {
  const list = (mod as ApiRemotesModule | undefined)?.API_REMOTE_FORWARDED_EVENTS
  if (!Array.isArray(list)) return false
  if (!list.some((entry) => entry?.event === PAUSE_STATUS_EVENT)) {
    list.push({ event: PAUSE_STATUS_EVENT, mode: 'emit' })
  }
  return true
}

/**
 * 注入 pause/status 到转发 allowlist。幂等；任何失败都静默放弃（客户端会在
 * 握手窗口内收不到帧，自动回退到轮询）。
 * @returns 是否确认注入成功（已存在也算成功）。
 */
export function installForwardedEvent(): boolean {
  for (const base of resolveBases()) {
    try {
      const req = createRequire(base)
      if (patchModule(req(req.resolve(REMOTES_PACKAGE)))) return true
    } catch {
      /* 换下一个起点 */
    }
  }
  return false
}
