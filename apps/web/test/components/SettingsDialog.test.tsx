import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsDialog } from '../../src/components/SettingsDialog.js'
import { useSettingsDialog } from '../../src/store/ui.js'
import { useSettings } from '../../src/store/settings.js'
import { useTheme } from '../../src/hooks/useTheme.js'

beforeEach(() => {
  // 组件渲染时读取构建期注入的全局常量（vite define），测试环境补一个桩
  vi.stubGlobal('__COMMIT_HASH__', 'testhash')
  useSettingsDialog.setState({ open: true })
  useSettings.setState({ level: 'exhigh' })
  useTheme.setState({ mode: 'dark' })
})

describe('SettingsDialog 音质选择', () => {
  it('只提供两档（一般 / 质量），并标出当前档位', () => {
    render(<SettingsDialog />)
    // 只有 balanced（exhigh）与 quality（hires）两个按钮
    expect(screen.getByTestId('quality-exhigh')).toBeInTheDocument()
    expect(screen.getByTestId('quality-hires')).toBeInTheDocument()
    expect(screen.queryByTestId('quality-lossless')).toBeNull()
    expect(screen.queryByTestId('quality-standard')).toBeNull()
    // 默认 exhigh → 一般选中
    expect(screen.getByTestId('quality-exhigh')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('quality-hires')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('点击「质量」写入 hires；点击「一般」写回 exhigh', () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByTestId('quality-hires'))
    expect(useSettings.getState().level).toBe('hires')
    fireEvent.click(screen.getByTestId('quality-exhigh'))
    expect(useSettings.getState().level).toBe('exhigh')
  })

  it('旧的无损档位归入「质量」模式（兼容历史持久化值）', () => {
    useSettings.setState({ level: 'lossless' })
    render(<SettingsDialog />)
    expect(screen.getByTestId('quality-hires')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByTestId('quality-exhigh')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('按钮只写「一般 / 质量」，描述行不暴露具体码率', () => {
    render(<SettingsDialog />)
    expect(screen.getByTestId('quality-exhigh')).toHaveTextContent(/^一般$/)
    expect(screen.getByTestId('quality-hires')).toHaveTextContent(/^质量$/)
    const section = screen.getByText('音质').closest('section')!
    // 分区内没有说明段落，也不暴露具体码率
    expect(section.querySelector('p')).toBeNull()
    expect(section.textContent).not.toMatch(/Kbps|Hi-Res|无损|320/)
  })
})

describe('SettingsDialog 外观', () => {
  it('外观分区只有「明暗切换」与「上传 / 移除背景」两个二元按钮，没有说明文字', () => {
    render(<SettingsDialog />)
    const section = screen.getByText('外观').closest('section')!
    // 默认深色：按钮显示月亮图标与「深色」
    const toggle = screen.getByTestId('theme-toggle')
    expect(section).toContainElement(toggle)
    expect(toggle).toHaveTextContent(/^深色$/)
    expect(section).toContainElement(screen.getByTestId('pick-background'))
    expect(screen.getByTestId('pick-background')).toHaveTextContent(
      /^上传背景$/,
    )
    // 分区内只有两个按钮，没有说明段落
    expect(section.querySelector('p')).toBeNull()
    expect(screen.queryByTestId('theme-system')).toBeNull()
    expect(screen.queryByTestId('theme-light')).toBeNull()
    expect(screen.queryByTestId('theme-dark')).toBeNull()
  })

  it('点击明暗按钮在深色 / 浅色之间切换', () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(useTheme.getState().mode).toBe('light')
    expect(screen.getByTestId('theme-toggle')).toHaveTextContent(/^浅色$/)
    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('已设置背景时背景按钮变为「移除背景」', () => {
    useSettings.setState({ background: { kind: 'image', mime: 'image/png' } })
    render(<SettingsDialog />)
    const btn = screen.getByTestId('clear-background')
    expect(btn).toHaveTextContent(/^移除背景$/)
    expect(screen.queryByTestId('pick-background')).toBeNull()
  })
})
