import { MoocCompanion } from './host/service.mjs'

/** 页面接口依赖 Web 连接的 connection 服务；这个 profile 里一定有。 */
export const inject = ['connection']

/**
 * 插件只有这一行。Host 负责浏览器、登录、课程、任务和 LLM 调用；
 * Client 负责左侧栏入口和页面。所有运行资源都挂在 ctx.effect 上。
 */
export function apply(ctx, config) {
  const companion = new MoocCompanion(ctx, config)
  ctx.effect(() => {
    const dispose = companion.start()
    return () => {
      try { dispose?.() } catch { /* ignore */ }
      companion.dispose()
    }
  }, 'mooc-companion: lifecycle')
}
