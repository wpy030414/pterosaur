import type { MusicSource } from '@pterosaur/shared/types'

/** 搜索结果的五个类别（也是独立类别页的路径段）。 */
export type SearchCategory =
  | 'songs'
  | 'cassette'
  | 'artists'
  | 'albums'
  | 'playlists'

/** 全部类别，顺序即主搜索页里分区的纵向顺序。 */
export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'songs',
  'cassette',
  'artists',
  'albums',
  'playlists',
]

/** 磁带渠道（B 站）：磁带即「类歌单的合集」，见 ADR-044。 */
export const CASSETTE_SOURCE: MusicSource = 'bilibili'

/**
 * 类别的静态描述。
 *
 * - `label`：界面文案（分区标题、独立页标题、「查看更多」按钮）。
 * - `subtitle`：分区标题下的次要说明。
 * - `apiType`：查 `/api/search/all?type=` 时用的类型。磁带渠道没有歌曲 / 艺人 / 专辑，
 *   它的「视频」在接口上就是歌单（Playlist），故恒为 `playlists`。
 */
export const SEARCH_CATEGORY_META: Record<
  SearchCategory,
  {
    label: string
    subtitle: string
    apiType: 'songs' | 'artists' | 'albums' | 'playlists'
  }
> = {
  songs: { label: '歌曲', subtitle: '单曲结果', apiType: 'songs' },
  cassette: { label: '磁带', subtitle: 'B 站视频合集', apiType: 'playlists' },
  artists: { label: '艺人', subtitle: '歌手与乐队', apiType: 'artists' },
  albums: { label: '专辑', subtitle: '唱片专辑', apiType: 'albums' },
  playlists: { label: '歌单', subtitle: '精选歌单', apiType: 'playlists' },
}

/**
 * 某类别的每页条数——须与后端一致：`/api/search/all` 四类都按请求的 `limit` 返回。
 *
 * 歌曲取 24：综合搜索的歌曲网格是「4 行 × 6 列」，首屏恰好铺满且不触发目录式层层下滚；
 * 想看更多走滑轨尾部「更多」进独立类别页续页。
 */
export const SEARCH_PAGE_SIZE: Record<SearchCategory, number> = {
  songs: 24,
  cassette: 20,
  artists: 20,
  albums: 20,
  playlists: 20,
}

/** 路径段是否是一个合法类别（用于 `/search/:category` 的白名单校验）。 */
export function isSearchCategory(v: string | undefined): v is SearchCategory {
  return !!v && (SEARCH_CATEGORIES as readonly string[]).includes(v)
}

/** 类别对应的查询源：磁带走 B 站，其余跟随当前音乐源。 */
export function sourceForCategory(
  category: SearchCategory,
  musicSource: MusicSource,
): MusicSource {
  return category === 'cassette' ? CASSETTE_SOURCE : musicSource
}

/** 独立类别页的地址（`/search/{类别}?q=`）。 */
export function categoryPath(category: SearchCategory, q: string): string {
  return `/search/${category}?q=${encodeURIComponent(q)}`
}
