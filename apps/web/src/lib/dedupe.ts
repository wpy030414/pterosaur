/**
 * 按身份键去重（保留首次出现）。
 *
 * 上游分页会**跨页返回同一实体**——实测 B 站搜索结果第 1、2 页都含同一个 bvid，网易云
 * 也偶有重叠；「滚动续页」把各页拼接成累积列表，于是出现重复项。
 *
 * 这不只是「多画一张卡」：累积列表的 React `key` 一旦重复（控制台会警告
 * `Encountered two children with the same key … may cause children to be duplicated and/or
 * omitted`），协调（reconciliation）就会错乱——**旧节点可能残留在 DOM 里**。换 tab 时网格
 * 容器被复用，残留的卡片就跟着留在新 tab 上，表现为「上一个 tab 的卡片混进来」（见 ADR-046）。
 *
 * 故所有「分页累积」处一律先去重。
 *
 * @param keyOf 身份键函数（用 `@pterosaur/shared/types` 的 `keyOf` = `<source>:<id>`）。
 */
export function dedupeByKey<T>(
  list: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of list) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
