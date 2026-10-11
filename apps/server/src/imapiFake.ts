import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { BurnRequest, DiscProbe, PsEvent } from './imapi.js'

/**
 * **模拟刻录缝**（`PTEROSAUR_RIP_FAKE_BURN=1`，见 ADR-048）。
 *
 * 无光驱的开发 / CI 环境用它将整条「实体分发」链路（job 编排 → SSE 进度 →
 * 前端下载 meta.json）真实跑通；并在 data 模式校验暂存产物确实含 `meta.json`、
 * audio 模式校验转码轨道非空——让模拟路径也执行产物断言，而非空转。
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 模拟一台就绪的刻录机 + 空白 CD-R。 */
export function fakeProbe(): DiscProbe {
  return {
    recorders: [{ id: 'pterosaur-fake-drive', product: 'Pterosaur Fake Burner' }],
    mediaPresent: true,
    blank: true,
    profile: 'CD-R',
    capacityBytes: 700 * 1024 * 1024,
    simulated: true,
  }
}

export async function fakeBurn(
  req: BurnRequest,
  onEvent: (e: PsEvent) => void,
): Promise<void> {
  if (req.mode === 'data') {
    // 数据 CD 必须已写好元信息（job 编排的产物断言）
    await access(join(req.stagingDir, 'meta.json'))
  } else if (!req.audioTracks?.length) {
    throw new Error('模拟刻录失败：音频 CD 缺少转码轨道')
  }

  // 刻录阶段刻意放慢（~0.5s）：让前端 / E2E 能稳定观察到不确定进度环
  onEvent({ event: 'phase', phase: 'preparing' })
  await delay(50)
  onEvent({ event: 'phase', phase: 'writing' })
  await delay(400)
  onEvent({ event: 'phase', phase: 'finalizing' })
  await delay(50)
  onEvent({ event: 'done' })
}
