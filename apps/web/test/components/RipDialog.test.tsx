import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RipDialog } from '../../src/components/RipDialog.js'
import { ripDialog, useRipDialog } from '../../src/store/ui.js'
import { api } from '../../src/api/client.js'
import type { RipCapabilities } from '@pterosaur/shared/rip'

vi.mock('../../src/api/client.js', () => ({
  api: { ripCapabilities: vi.fn() },
}))

const mockedCaps = vi.mocked(api.ripCapabilities)

const caps = (over: Partial<RipCapabilities> = {}): RipCapabilities => ({
  platform: 'win32',
  simulated: false,
  supported: true,
  recorders: [{ id: 'fake-drive', product: 'Fake Burner' }],
  media: {
    present: true,
    blank: true,
    profile: 'CD-RW',
    dataSupported: true,
    audioSupported: true,
  },
  ffmpeg: { available: true, version: '4.1' },
  audioCd: { maxSeconds: 4740 },
  ...over,
})

const opts = { name: '测试合集', trackCount: 3, totalDuration: 600 }

beforeEach(() => {
  useRipDialog.setState({ open: false, options: null, resolve: null })
  mockedCaps.mockReset()
})

describe('RipDialog', () => {
  it('默认数字分发，确认返回 digital 选择；非本机不发 capabilities 请求', async () => {
    const p = ripDialog(opts)
    render(<RipDialog loopback={false} />)
    expect(screen.getByTestId('rip-dist-digital')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(mockedCaps).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开始翻录' }))
    await expect(p).resolves.toEqual({ distribution: 'digital' })
  })

  it('非本机：实体分发显示原因且不可开始；Esc 取消', async () => {
    const p = ripDialog(opts)
    render(<RipDialog loopback={false} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    expect(screen.getByTestId('rip-reason')).toHaveTextContent(/仅在本机/)
    expect(screen.getByRole('button', { name: '开始刻录' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await expect(p).resolves.toBeNull()
  })

  it('本机 + 能力可用：数据 CD 可开始并回填选择', async () => {
    mockedCaps.mockResolvedValue(caps())
    const p = ripDialog(opts)
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-caps')).toHaveTextContent('刻录机 1 台'),
    )
    expect(screen.queryByTestId('rip-reason')).toBeNull()
    const start = screen.getByRole('button', { name: '开始刻录' })
    expect(start).toBeEnabled()
    fireEvent.click(start)
    await expect(p).resolves.toEqual({
      distribution: 'physical',
      discType: 'data',
    })
  })

  it('ffmpeg 缺失：音频 CD 禁用并给原因', async () => {
    mockedCaps.mockResolvedValue(caps({ ffmpeg: { available: false } }))
    ripDialog(opts)
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-caps')).toHaveTextContent('刻录机 1 台'),
    )
    expect(screen.getByTestId('rip-disc-audio')).toBeDisabled()
    expect(screen.getByTestId('rip-audio-reason')).toHaveTextContent(/ffmpeg/)
  })

  it('介质不支持音频 CD：禁用并给原因（IsCurrentMediaSupported 口径）', async () => {
    mockedCaps.mockResolvedValue(
      caps({
        media: {
          present: true,
          blank: true,
          profile: 'CD-RW',
          dataSupported: true,
          audioSupported: false,
        },
      }),
    )
    ripDialog(opts)
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-caps')).toHaveTextContent('刻录机 1 台'),
    )
    expect(screen.getByTestId('rip-disc-audio')).toBeDisabled()
    expect(screen.getByTestId('rip-audio-reason')).toHaveTextContent(
      /不支持音频 CD 刻录/,
    )
  })

  it('介质不支持数据 CD：数据模式下不可开始并给原因', async () => {
    mockedCaps.mockResolvedValue(
      caps({
        media: {
          present: true,
          blank: true,
          profile: 'DVD-R',
          dataSupported: false,
        },
      }),
    )
    ripDialog(opts)
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-caps')).toHaveTextContent('刻录机 1 台'),
    )
    expect(screen.getByTestId('rip-data-reason')).toHaveTextContent(
      /不支持数据刻录/,
    )
    expect(screen.getByRole('button', { name: '开始刻录' })).toBeDisabled()
  })

  it('总时长超出音频 CD 上限：音频 CD 禁用并给原因', async () => {
    mockedCaps.mockResolvedValue(caps())
    ripDialog({ name: '长合集', trackCount: 100, totalDuration: 6000 })
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-caps')).toHaveTextContent('刻录机 1 台'),
    )
    expect(screen.getByTestId('rip-disc-audio')).toBeDisabled()
    expect(screen.getByTestId('rip-audio-reason')).toHaveTextContent(
      /超出音频 CD 上限/,
    )
  })

  it('未检测到刻录机：实体不可开始', async () => {
    mockedCaps.mockResolvedValue(
      caps({ recorders: [], media: { present: false, blank: false } }),
    )
    ripDialog(opts)
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    await waitFor(() =>
      expect(screen.getByTestId('rip-reason')).toHaveTextContent(
        /未检测到刻录机/,
      ),
    )
    expect(screen.getByRole('button', { name: '开始刻录' })).toBeDisabled()
  })

  it('跨源合集：实体分发给原因；取消返回 null', async () => {
    mockedCaps.mockResolvedValue(caps())
    const p = ripDialog({ ...opts, mixedSources: true })
    render(<RipDialog loopback={true} />)
    fireEvent.click(screen.getByTestId('rip-dist-physical'))
    expect(screen.getByTestId('rip-reason')).toHaveTextContent(/跨多个音源/)
    expect(screen.getByRole('button', { name: '开始刻录' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await expect(p).resolves.toBeNull()
  })
})
