import type { ButtonHTMLAttributes } from 'react'
import './IconButton.css'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标（lucide 组件），由调用方以 `<Icon size={..}/>` 传入 children */
  label: string
  /** 视觉尺寸 */
  size?: 'sm' | 'md' | 'lg'
  /** 是否为「激活」态（如随机/循环开启） */
  active?: boolean
}

/**
 * 统一的图标按钮：带 aria-label、聚焦环、激活态样式。
 */
export function IconButton({
  label,
  size = 'md',
  active,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[
        'icon-btn',
        `icon-btn--${size}`,
        active ? 'icon-btn--active' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}
