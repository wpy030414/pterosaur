import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth, activeMusicSource } from '../store/auth.js'
import {
  DEFAULT_SOURCE,
  isMusicSource,
  type LoginStatus,
  type MusicSource,
} from '@pterosaur/shared/types'

/** 实体路由 `/playlist|artist|album/:source/:id`（2 段式别名时首段是 id，会被 `isMusicSource` 滤掉）。 */
const ENTITY_ROUTE = /^\/(?:playlist|artist|album)\/([^/]+)/

/**
 * 当前所处「源」：实体路由 / 搜索显式带源时**以路由为准**（无论是否登录），
 * 否则跟随**活动账号**（未登录回落缺省源）。
 */
function currentSource(
  pathname: string,
  search: string,
  status: Record<MusicSource, LoginStatus>,
): MusicSource {
  const m = ENTITY_ROUTE.exec(pathname)
  if (m && isMusicSource(m[1])) return m[1]
  if (pathname === '/search') {
    const s = new URLSearchParams(search).get('source')
    if (isMusicSource(s)) return s
  }
  return activeMusicSource(status) ?? DEFAULT_SOURCE
}

/**
 * 给 `<html>` 打 `data-source="<源>"`，触发 `tokens.css` 里对应的强调色。
 *
 * 当前仅网易云一个源，即缺省（中性）强调色；机制保留以便将来新增源时零改动接入
 * （新源只需在 `tokens.css` 增 `:root[data-source='<新源>']` 覆盖块）。
 */
export function useSourceTheme(): void {
  const location = useLocation()
  const status = useAuth((s) => s.status)
  const source = currentSource(location.pathname, location.search, status)
  useEffect(() => {
    document.documentElement.dataset.source = source
  }, [source])
}
