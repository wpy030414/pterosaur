/**
 * 由字符串（曲目 / 专辑 / 歌单 id）派生**确定性的**封面图。
 *
 * 同一个 id 永远得到同一张图——列表滚动、重新渲染、翻页回来都是同一张，
 * 不会像随机图那样「闪来闪去」。
 *
 * ## 视觉目标
 * 对齐 Apple Music 的默认封面：几块**柔边但边界清晰**的大色块互相咬合，
 * 明暗对比明显，像透过毛玻璃看一组彩色灯。刻意不画图标、不画频谱柱。
 *
 * ## 三条关键做法（是试出来的，不要随意改回去）
 * 1. **色块半径约 50–60%**，不是铺满画布。太大就糊成一片单色雾。
 * 2. **每个色块多插一个不透明色标**（`色 0%, 色 46%, 透明 78%`）。
 *    只写 `色 0%, 透明 100%` 得到的是通体渐隐的雾；中间那个色标让颜色
 *    「维持住」到接近边缘再淡出，才形成可见的过渡带。
 * 3. **明度对比拉大**：高光块比暗块亮 40 以上，画面才有立体感。
 *
 * ## 配色原则
 * 不取随机色相（容易撞出刺眼撞色）。从人工挑过的**色相族**里选一族，
 * 族内三色相邻（跨度 30–60°），咬合时天然和谐。
 */

/** FNV-1a 32 位：短、分布均匀，且不需要任何依赖。 */
function hashOf(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    // h *= 16777619，用移位拆分避免超过 32 位整数精度
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h >>> 0
}

/** 取 [0,1) 的确定性小数（从 seed 的哈希再派生，不同盐互不相关）。 */
function unit(h: number, salt: number): number {
  return hashOf(`${h}:${salt}`) / 0xffffffff
}

/** CSS 颜色；`a < 1` 时用斜杠透明度语法。 */
const hsl = (h: number, s: number, l: number, a = 1): string =>
  a === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`

/**
 * 色相族：每族的三个色相（高光 / 主 / 深）相邻，跨度 30–60°，咬合时和谐。
 * 饱和度与明度在下方按种子小范围浮动，避免所有封面长得一样。
 */
const FAMILIES = [
  { a: 270, b: 302, c: 246 }, // 紫
  { a: 348, b: 6, c: 322 }, // 玫红
  { a: 30, b: 46, c: 8 }, // 橙金
  { a: 196, b: 214, c: 178 }, // 青
  { a: 152, b: 172, c: 132 }, // 松绿
] as const

export interface CoverArt {
  /** 多块色块咬合而成的柔焦渐变，可直接作为 CSS `background`。 */
  background: string
}

/**
 * 为一个 seed 生成封面图参数。
 *
 * @param seed 形如 `netease:12345` 的身份键（见 shared `keyOf`）；缺省时用固定值。
 */
export function coverArtFor(seed: string): CoverArt {
  const h = hashOf(seed || 'pterosaur')

  const fam = FAMILIES[Math.floor(unit(h, 1) * FAMILIES.length)]
  const sat = 66 + Math.round(unit(h, 2) * 18) // 66–84
  const light = 56 + Math.round(unit(h, 3) * 8) // 56–64

  /** 半径 / 位置各自的小幅抖动，避免每张图长得一样。 */
  const radius = (base: number, salt: number) =>
    base + Math.round(unit(h, salt) * 14)
  const pos = (salt: number) => Math.round(unit(h, salt) * 18)

  // 三档明度：高光远亮于深色，才有立体感
  const highL = light + 30
  const mainL = light + 2
  const deepL = Math.max(26, light - 34)

  const high = hsl(fam.a, sat, highL)
  const main = hsl(fam.b, sat + 6, mainL)
  const deep = hsl(fam.c, sat - 10, deepL)

  /*
   * 三块色块分居三角，中间自然叠出第四种颜色。
   * 每块都带「维持色标」：`色 0%, 色 <44~52>%, 透明 <78~82>%`。
   */
  const background = [
    // 1) 左上：最亮的高光块，给出光源方向
    `radial-gradient(ellipse ${radius(50, 20)}% ${radius(56, 21)}% at ${16 + pos(22)}% ${12 + pos(23)}%, ${high} 0%, ${high} 46%, ${hsl(fam.a, sat, highL, 0)} 78%)`,
    // 2) 右下：主色块，面积略大
    `radial-gradient(ellipse ${radius(54, 24)}% ${radius(60, 25)}% at ${62 + pos(26)}% ${64 + pos(27)}%, ${main} 0%, ${main} 52%, ${hsl(fam.b, sat + 6, mainL, 0)} 82%)`,
    // 3) 右上：深色块压角，制造纵深
    `radial-gradient(ellipse ${radius(44, 28)}% ${radius(50, 29)}% at ${58 + pos(30)}% ${10 + pos(31)}%, ${deep} 0%, ${deep} 44%, ${hsl(fam.c, sat - 10, deepL, 0)} 80%)`,
    // 4) 底色兜底，保证任何空隙都有颜色
    hsl(fam.a, sat, light - 4),
  ].join(', ')

  return { background }
}
