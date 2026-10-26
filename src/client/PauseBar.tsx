/**
 * dsh-pause 暂停控件：挂在 composer 工具行右侧 conversation.input.right。
 *
 * 目标交互：
 * - 开关按钮，本会话总开关。
 * - 暂停时在 host 报 paused 的状态下于 composer 主输入框按裸 Enter 即继续。草稿为空则无感放行，草稿有字则作为插话放行并清空草稿。
 * - 未暂停时不拦截任何按键，完全透明。
 *
 * 状态同步（两层，自动降级）：
 * 1. 推送：host 经 $events 通道转发 pause/status（allowlist 由本插件在模块求值
 *    阶段注入，见 forwarded-events）。收到任意帧即确认链路存活（握手窗口 4s），
 *    paused/enabled 即时更新，零轮询。
 *    推送走 WebSocket，不占 HTTP 并发连接，也不在 DevTools 请求列表留记录。
 * 2. 回退：注入失败时降级为轮询，间隔按 enabled 分档（见 ARMED_POLL_MS）。
 *
 * 拦截只在 host 明确报 paused 时挂载。未暂停时不碰任何按键，Enter 全走官方
 * keymap——不代用户提交，因为 InputActions.submit() 在官方实现里写死
 * submit('queue')，会覆盖用户配置的 busyEnter=steer。
 *
 * dsh 的 composer Enter 由 InputBar 私有 keymap 处理，第三方没有正式 hook 点，
 * 故本组件在暂停态对所属 composer 挂 document 级 capture-phase keydown，抢在 Lexical 之前拦截裸 Enter。
 *
 * @module dsh-pause/client
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DraftAttachmentId, InputActions, InputState, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 注册时注入读条组件、按钮所需的业务面。 */
export interface PauseBarInjected {
  /** Connection RPC 调用器，主机端提供 /dsh-pause。 */
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
  }
  /** 把草稿附件序列化成可随插话提交的载荷。 */
  readonly serializeAttachments?: (ids: readonly DraftAttachmentId[]) => Promise<readonly SubmitAttachment[]>
  /** host 经 $events 推送的事件订阅；缺失或链路未握手成功时自动回退轮询。 */
  readonly remote?: {
    $on(event: string, listener: (payload: unknown) => void): () => void
  }
}

/** conversation.input.right 的 session 作用域组件收到的标准 props + 注入面。 */
export interface PauseControlProps extends PauseBarInjected {
  /** 框架解析出的会话 id。 */
  sessionId: string
  /** 会话输入状态选择器钩子，用于读草稿。 */
  useInput: SnapshotSelectorHook<InputState>
  /** 会话输入动作，用于清空草稿。 */
  inputActions: InputActions
}

/** 主机端返回的会话状态。 */
interface PauseStatus {
  enabled?: boolean
  paused?: boolean
}

/** 推送帧形状（与 host 端 emit 一致）。 */
interface PausePushPayload {
  sessionId?: unknown
  enabled?: unknown
  paused?: unknown
}

/** 推送链路握手窗口：此时间内收到任意 pause/status 帧即确认注入成功。 */
const PUSH_HANDSHAKE_MS = 4000
/**
 * 回退轮询间隔（推送不可用时）。
 *
 * 间隔按「此刻会不会有盲窗」分档，而不是全程用最短间隔：
 * - 开关关着（`enabled === false`）：不可能拉门，也就没有盲窗可言，
 *   只需慢速探到「别的客户端打开了开关」，故用 {@link IDLE_POLL_MS}。
 * - 开关开着（`enabled === true`）：随时可能进入 paused，盲窗宽度直接由
 *   间隔决定，故用 {@link ARMED_POLL_MS}。
 * - 已经 paused 时没有额外收益：门已在等按键，慢一点也只是延后「门被别处
 *   放行」的显示，保持 ARMED 档即可。
 *
 * 空闲会话的请求量因此降一个数量级，而开关开着时的盲窗宽度不受影响。
 */
const ARMED_POLL_MS = 400
const IDLE_POLL_MS = 5000

async function fetchStatus(rpc: PauseBarInjected['rpc'], sessionId: string): Promise<PauseStatus | undefined> {
  try {
    const result = await rpc.call('/dsh-pause', 'status', { sessionId })
    if (result.ok) return result.value as PauseStatus | undefined
    return undefined
  } catch {
    return undefined
  }
}

/** 一次放行的结果；error 存在表示主机拒绝，门未放行。 */
interface ReleaseOutcome {
  readonly released: boolean
  readonly error?: string
}

async function callRelease(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  text: string,
  images: readonly SubmitAttachment[],
): Promise<ReleaseOutcome> {
  try {
    const result = await rpc.call('/dsh-pause', 'release', { sessionId, text, images })
    if (!result.ok) return { released: false, error: result.error?.message ?? '放行失败' }
    const value = result.value as { released?: boolean } | undefined
    return { released: value?.released === true }
  } catch (error) {
    return { released: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function callSetEnabled(rpc: PauseBarInjected['rpc'], sessionId: string, enabled: boolean): Promise<void> {
  try {
    await rpc.call('/dsh-pause', 'setEnabled', { sessionId, enabled })
  } catch {
    // 忽略：失败时本地开关不落定，下次轮询/推送会回正
  }
}

/**
 * 放行一扇门：draft 与图片一起作为插话，空则无感继续。
 * 附件必须先序列化并随放行请求上传；主机拒绝时保持门与草稿原样，避免出现只发文字、图片残留的状态。
 */
async function releaseAndClear(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  draft: string,
  attachmentIds: readonly DraftAttachmentId[],
  serializeAttachments: PauseBarInjected['serializeAttachments'],
  inputActions: InputActions | undefined,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  let attachments: readonly SubmitAttachment[] = []
  if (attachmentIds.length > 0) {
    if (serializeAttachments === undefined) {
      onError('当前环境不支持附件插话，请先发送或移除附件')
      return
    }
    try {
      attachments = await serializeAttachments(attachmentIds)
    } catch (error) {
      onError('附件无法随插话发送：' + (error instanceof Error ? error.message : String(error)))
      return
    }
  }
  if (attachments.some((part) => part.type !== 'image')) {
    onError('暂停中只支持图片插话，请先移除文件附件')
    return
  }
  const outcome = await callRelease(rpc, sessionId, draft, attachments)
  if (outcome.error !== undefined) {
    onError(outcome.error)
    return
  }
  if (!outcome.released) {
    onDone()
    return
  }
  if (draft !== '' && inputActions !== undefined) inputActions.setDraft('')
  if (inputActions !== undefined) {
    for (const id of attachmentIds) inputActions.removeAttachment(id)
  }
  onDone()
}

/**
 * 暂停图标：两条竖线，单色 currentColor 跟随主题。
 */
function PauseIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x={3.6} y={2.4} width={3.4} height={11.2} rx={1.2} />
      <rect x={9} y={2.4} width={3.4} height={11.2} rx={1.2} />
    </svg>
  )
}

/**
 * 暂停控件。只在 host 报 paused 时挂 document capture 拦截裸 Enter 改走放行；未暂停不碰按键。
 */
export const PauseControl = memo(function PauseControl({
  rpc,
  sessionId,
  useInput,
  inputActions,
  serializeAttachments,
  remote,
}: PauseControlProps) {
  const [enabled, setEnabled] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** null=握手未定（轮询兜底）；true=推送链路存活（零轮询）；false=链路失败（回退轮询）。 */
  const [pushLive, setPushLive] = useState<boolean | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // render 内 subscribe：草稿与附件变化会触发本组件重渲染并更新 ref。
  // 注意：不能在 capture 事件处理器里调 useInput，因为 hook 只在 render 期合法，故存 ref。
  const draft = useInput((state: InputState) => state.draft)
  const attachmentIds = useInput((state: InputState) => state.attachmentIds)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const idsRef = useRef(attachmentIds)
  idsRef.current = attachmentIds
  // capture 处理器要读最新 rpc/sessionId/inputActions，也用 ref 规避闭包过期。
  const gateRef = useRef<{ release: () => void }>({ release: () => {} })
  // 放行中的重复 Enter 或连点不再发起第二次上传，避免同一批图片被提交两次。
  const releasingRef = useRef(false)
  gateRef.current = {
    release: () => {
      if (releasingRef.current) return
      releasingRef.current = true
      setError(undefined)
      const pending = releaseAndClear(
        rpc,
        sessionId,
        draftRef.current,
        idsRef.current,
        serializeAttachments,
        inputActions,
        () => setPaused(false),
        (message) => setError(message),
      )
      void pending.finally(() => { releasingRef.current = false })
    },
  }

  // 推送链路：订阅 host 转发的 pause/status。收到任意帧（首个 status 回包会带回推
  // 帧，充当握手探针）即确认存活；4s 内无帧则回退轮询。仅本会话的帧更新 enabled/paused。
  useEffect(() => {
    if (remote === undefined || typeof remote.$on !== 'function') {
      setPushLive(false)
      return
    }
    let live = false
    const dispose = remote.$on('pause/status', (payload: unknown) => {
      live = true
      setPushLive(true)
      const frame = payload as PausePushPayload
      if (frame?.sessionId === sessionId) {
        if (typeof frame.enabled === 'boolean') setEnabled(frame.enabled)
        if (typeof frame.paused === 'boolean') setPaused(frame.paused)
      }
    })
    const timer = setTimeout(() => { if (!live) setPushLive(false) }, PUSH_HANDSHAKE_MS)
    return () => { dispose(); clearTimeout(timer) }
  }, [remote, sessionId])

  // 回退轮询：推送链路未确认/失败时跟踪状态，链路存活后停止（零轮询）。
  // 用自调度的 setTimeout 链而不是固定 setInterval：每次回包后按最新的 enabled
  // 决定下一次间隔（开关关着就慢、开着就快），无需把 enabled 放进依赖里重建定时器。
  useEffect(() => {
    if (pushLive === true) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 最近一次已知的开关状态；首次回包前按「关」处理，与初始渲染一致。 */
    let armed = false
    const schedule = (): void => {
      if (disposed) return
      timer = setTimeout(() => { void poll() }, armed ? ARMED_POLL_MS : IDLE_POLL_MS)
    }
    const poll = async (): Promise<void> => {
      const s = await fetchStatus(rpc, sessionId)
      if (disposed) return
      if (s === undefined) {
        // 失败时按当前档位重试，不清状态：网络抖动不该把已知的 enabled 抹掉。
        schedule()
        return
      }
      armed = s.enabled === true
      setEnabled(s.enabled ?? false)
      setPaused(s.paused ?? false)
      schedule()
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [rpc, sessionId, pushLive])

  // 只在 host 明确报 paused 时挂 capture：document 捕获阶段抢在 Lexical 前拦裸 Enter。
  // 推送链路存活时 paused 即时、无盲窗；回退时靠 400ms 轮询兜底，盲窗最宽 400ms。
  useEffect(() => {
    if (!paused) return
    const onCapture = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return
      if (event.isComposing || event.keyCode === 229) return
      const root = rootRef.current
      if (root === null || !root.isConnected) return
      const card = root.closest('[data-composer-card]')
      if (card === null || !card.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      void gateRef.current.release()
    }
    document.addEventListener('keydown', onCapture, true)
    return () => document.removeEventListener('keydown', onCapture, true)
  }, [paused])

  const toggle = async (next: boolean): Promise<void> => {
    setError(undefined)
    setEnabled(next)
    await callSetEnabled(rpc, sessionId, next)
  }

  return (
    <div
      ref={rootRef}
      data-dsh-pause="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 4px',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
      }}
    >
      <button
        type="button"
        aria-pressed={enabled}
        title={enabled ? '暂停已开启' : '开启暂停，工具续跑前会停下'}
        onClick={() => { void toggle(!enabled) }}
        style={{
          cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          background: enabled ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
          color: enabled ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-secondary)',
          padding: '1px 8px',
          fontSize: '12px',
          lineHeight: '18px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <PauseIcon />
        {enabled ? '暂停开' : '暂停'}
      </button>
      {paused && (
        <button
          type="button"
          onClick={() => { void gateRef.current.release() }}
          style={{
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-state-business-primary)',
            borderRadius: '6px',
            background: 'var(--dsw-alias-state-business-primary)',
            color: 'var(--dsw-alias-label-primary-inverted)',
            padding: '1px 8px',
            fontSize: '12px',
            lineHeight: '18px',
          }}
        >
          已暂停·回车或点此继续
        </button>
      )}
      {error !== undefined && (
        <span style={{ color: 'var(--dsw-alias-label-error, #d9534f)', fontSize: '12px' }}>
          {error}
        </span>
      )}
    </div>
  )
})

export type PauseBarProps = PauseControlProps

