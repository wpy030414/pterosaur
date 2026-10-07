import type { Track } from '@pterosaur/shared/types'
import { api } from '../api/client.js'

/**
 * 曲目「一对一 → 一对多」展开。
 *
 * 磁带（B 站视频）可能是**分P 视频**（一个视频内含多段）。历史路径（旧 MV tab 的逐条播放、
 * 本地歌单里残留的裸 `bvid` 曲目）点一行时，队列里应实际新增 N 项（见 ADR-033 / ADR-044）。展开
 * 出的条目就是普通 `Track`（身份为 `bilibili:<bvid>:<cid>`），因此能与歌曲一起进歌单 / 队列、
 * 收藏与排序。
 *
 * 磁带改造后，磁带卡与磁带详情页拿到的已是展开好的分P（`bvid:cid`），不会走到这里；本模块主要
 * 服务于**旧数据**与其它列表的兜底展开。
 */

/** 展开单个曲目；非磁带渠道、已是分P 条目、或展开失败时**原样返回单项**（绝不阻断播放）。 */
export async function expandTrack(track: Track): Promise<Track[]> {
  // 非 B 站源，或已是具体分P（id 形如 `bvid:cid`）→ 无需展开
  if (track.source !== 'bilibili' || track.id.includes(':')) return [track]
  try {
    const parts = await api.parts(track.source, track.id)
    return parts.length ? parts : [track]
  } catch {
    return [track]
  }
}

/**
 * 批量展开，返回**与入参等长的分组**（`groups[i]` 是 `tracks[i]` 展开出的条目）。
 *
 * 保留分组是为了让调用方按「点的是第几行」推算它在展开后队列中的起始下标。
 * 无 B 站条目时不发任何网络请求（其余源直接各成一组）。
 */
export function expandGroups(tracks: Track[]): Promise<Track[][]> {
  return Promise.all(tracks.map(expandTrack))
}

/** 批量展开为**扁平列表**（顺序保留）。 */
export async function expandList(tracks: Track[]): Promise<Track[]> {
  const groups = await expandGroups(tracks)
  return groups.flat()
}
