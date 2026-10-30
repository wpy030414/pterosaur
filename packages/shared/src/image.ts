/**
 * 网易云图片 CDN 地址规范化。
 *
 * 背景（2026-10 实测验证，见 DECISIONS.md ADR-020）：网易云 API 对同一封面会在
 * `p1`–`pN.music.126.net` 之间**随机轮换主机名**——同端点两次调用、跨端点（搜索 /
 * 详情）均会出现 p1/p3/p4 混用，另有 http/https 混用；而**路径（`{hash}/{id}.jpg`）
 * 才是封面的稳定身份**。若直接以原始 URL 作缓存键（SW 媒体池、页面就绪登记表、
 * HTTP 缓存），同一张封面会被拆成多条缓存，命中率大幅下降。
 *
 * 决策：不按「类型 + ID」重构缓存键——曲目封面即专辑封面，按曲目 ID 会把同一专辑
 * 的封面重复存 N 份；改为把 URL **规范化**成固定形式（https + 固定镜像主机 + 唯一的
 * `param` 尺寸参数），使「同一封面 + 同一尺寸」在**所有缓存层**都得到同一字符串，
 * 同专辑的全部曲目也天然共享一条缓存。
 *
 * 查询串白名单（2026-10 补测，见 ADR-058）：部分歌单封面（用户自定义 / 活动生成）的
 * 地址上带着 `imageView=1&thumbnail=800y800&enlarge=...&watermark=...` 整串**图片处理
 * 参数**，其中 `imageView` 与有效果的 `enlarge`（如 `enlarge=2`、`enlarge=1|thumbnail:...`）
 * 并存时，CDN 直接回 `400 InvalidArgument`——封面整片裂开；而同一路径的裸地址正常返回
 * 原图。故规范化时只保留 `param`（尺寸），其余处理参数一律丢弃：尺寸由 `param` 精确
 * 控制、不损失画质，也顺带消掉「同一封面因水印参数不同被拆成多条缓存」的碎片。
 */

/** 规范化后固定使用的镜像主机（p1–pN 互为镜像、内容一致，任选其一）。 */
export const NETEASE_IMAGE_HOST = 'p3.music.126.net'

/** 是否网易云图片 CDN 镜像主机（仅 `p1`–`pN.music.126.net`，实测互为镜像；裸域行为未知，不动）。 */
function isNeteaseImageHost(hostname: string): boolean {
  return /^p\d+\.music\.126\.net$/.test(hostname)
}

/**
 * 规范化网易云图片地址：
 *
 * - `http:` → `https:`；
 * - `p\d+.music.126.net` → 固定镜像主机；
 * - 查询串**白名单**：只保留 `param`（缩放尺寸，多个只取**最后一个**），丢弃 `imageView` /
 *   `thumbnail` / `enlarge` / `watermark` / `type` / `image` / `dx` / `dy` 等图片处理参数
 *   （`imageView` 与有效果的 `enlarge` 并存会让 CDN 回 400，见文件头与 ADR-058）；
 * - 非网易云地址原样返回（不猜测其 CDN 行为）。
 */
export function canonicalNeteaseImage(url: string): string {
  if (!url) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!isNeteaseImageHost(u.hostname)) return url
  if (u.protocol !== 'https:') u.protocol = 'https:'
  if (u.hostname !== NETEASE_IMAGE_HOST) u.hostname = NETEASE_IMAGE_HOST
  const params = u.searchParams.getAll('param')
  u.search = ''
  if (params.length > 0) u.searchParams.set('param', params[params.length - 1])
  return u.href
}

/* ============================ 尺寸分档 ============================ */

/** 小图边长（px）：列表行、播放条、卡片网格、顶栏头像等。 */
export const COVER_SMALL = 300
/** 大图边长（px）：沉浸页封面与背景、专辑/艺术家/歌单详情 hero。 */
export const COVER_LARGE = 1200
/**
 * 翻录（打包下载）专辑封面边长（px）：**尽可能大**——实测（2026-10）网易云图片母带
 * 上限即 3000，`param` 请求再大也只回 3000×3000（体积相同、不上采样），故取 3000。
 * 若上游放宽上限，调大此常量即可。
 */
export const COVER_RIP = 3000

/**
 * 把封面/头像 URL 改写为指定边长（px），用于「按使用场景选画质」。
 *
 * - 网易云：经 {@link canonicalNeteaseImage} 规范化镜像主机后，设 `param={px}y{px}`；
 * - 其它 CDN / 非法地址：**原样返回**（不猜测其 CDN 行为）。
 *
 * 返回串即缓存稳定身份——「同一图 + 同一尺寸」在 SW 媒体池、就绪登记表等各层得到同一键。
 */
export function coverAt(
  url: string | undefined,
  px: number,
): string | undefined {
  if (!url) return url
  const size = `${px}x${px}`
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!isNeteaseImageHost(u.hostname)) return url
  const canonical = new URL(canonicalNeteaseImage(url))
  canonical.searchParams.delete('param')
  canonical.searchParams.set('param', size)
  return canonical.href
}
