import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AUDIO_LEVELS, DEFAULT_AUDIO_LEVEL } from '@pterosaur/shared/types'
import { SettingsDialog } from '../../src/components/SettingsDialog.js'
import { useSettingsDialog } from '../../src/store/ui.js'
import { useSettings } from '../../src/store/settings.js'

beforeEach(() => {
  // 组件渲染时读取构建期注入的全局常量（vite define），测试环境补一个桩
  vi.stubGlobal('__COMMIT_HASH__', 'testhash')
  useSettingsDialog.setState({ open: true })
  useSettings.setState({ level: DEFAULT_AUDIO_LEVEL })
})

describe('SettingsDialog 音质选择', () => {
  it('渲染全部档位按钮，并标出当前档位', () => {
    render(<SettingsDialog />)
    for (const lv of AUDIO_LEVELS) {
      expect(screen.getByTestId(`quality-${lv}`)).toBeInTheDocument()
    }
    expect(
      screen.getByTestId(`quality-${DEFAULT_AUDIO_LEVEL}`),
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('quality-lossless')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('点击档位写入 settings store', () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByTestId('quality-lossless'))
    expect(useSettings.getState().level).toBe('lossless')
  })
})
