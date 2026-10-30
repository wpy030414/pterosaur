/**
 * 由字符串（曲目 / 专辑 / 歌单 id）派生**确定性的**封面图。
 *
 * 同一个 id 永远得到同一张图——列表滚动、重新渲染、翻页回来都是同一张，
 * 不会像随机图那样「闪来闪去」。
 *
 * ## 视觉目标
 * 复刻 Apple Music 电台 / 歌单的艺术封面：**丝绸流体渐变**——
 * 几条带光晕的 S 形色带互相穿插晕染、一枚暖色光斑压角、深色打底，
 * 整体像柔焦的绸缎（macOS 抽象流体壁纸的质感）。
 *
 * ## 为什么用 SVG 而不是 CSS 渐变
 * CSS radial-gradient 的衰减是「同心圆」的，只能画出雾状圆斑；
 * 细长、有方向、边缘被大半径高斯柔化的色带必须用**路径 + feGaussianBlur**。
 * 产物是一枚 data URI，仍以 CSS `background` 一行接入（Cover 组件零改动）。
 *
 * ## 分层结构（viewBox 400×400，两档柔焦：色带轻糊、光团重糊）
 * 1. 深色打底 + 画布级 vignette（四角渐暗，制造纵深）；
 * 2. 深色团块：与光斑对角的暗部，让明暗不对称（重糊）；
 * 3. 副色带：中明度、较薄、以近垂直的倾角穿插；
 * 4. 主色带：亮色、厚、S 形，亮端指向光斑一角（光源方向感）；
 * 5. 暖色光斑：accent 色在某一角晕开——Apple 惯用的「暖光压冷底」；
 * 6. 高光带：一条极淡的白色薄带，给绸缎加「反光」。
 *
 * ## 配色原则
 * 不取随机色相（容易撞出刺眼撞色）。从人工挑过的**色相族**里选一族，
 * 族内主 / 亮 / 深三色相邻（跨度 30–60°），再配一枚跨 90° 以上的暖色 accent
 * 作光斑——冷底暖光正是 Apple Music 封面的层次来源。
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
 * 色相族：main / bright / deep 三色相邻（跨度 30–60°），accent 为跨色相的暖光。
 * 首族即截图里 Apple Music Classical 电台的「紫 + 琥珀」配方。
 * 族内三色的间距要拉开到肉眼可辨——小图（列表行）下全靠色相差认卡。
 */
const FAMILIES = [
  { main: 284, bright: 262, deep: 310, accent: 38 }, // 紫 + 琥珀
  { main: 348, bright: 322, deep: 12, accent: 28 }, // 玫红 + 蜜桃
  { main: 210, bright: 190, deep: 230, accent: 42 }, // 青 + 沙金
  { main: 155, bright: 136, deep: 178, accent: 55 }, // 松绿 + 柠金
  { main: 32, bright: 48, deep: 12, accent: 332 }, // 橙金 + 洋红
] as const

/**
 * 光斑可落的四角；tilt 为「主色带亮端指向该角」的基准旋转角。
 * 基准角远离 0°/180°（水平），配合小抖动保证色带**永远斜向**，
 * 不出现「平直横带」的呆板构图。
 */
const CORNERS = [
  { x: 52, y: 348, tilt: -28 }, // 左下
  { x: 348, y: 348, tilt: -152 }, // 右下
  { x: 52, y: 52, tilt: 28 }, // 左上
  { x: 348, y: 52, tilt: 152 }, // 右上
] as const

/**
 * 一条横贯画布的 **S 形**色带路径（倾角由 transform rotate 给出）。
 * y1 / y2 为左右两端的纵坐标，w 为厚度；k 为波幅——上下缘同相位平移，
 * 带宽沿波浪恒定，弯曲的是「带本身」。控制点左右交替越过弦线，
 * 形成先下后上（或先上后下）的 S 形走向，这是「丝绸」与「直带」的分界。
 */
function band(y1: number, y2: number, w: number, k: number): string {
  const ym = (y1 + y2) / 2
  return [
    `M -80 ${y1}`,
    `C 60 ${y1 + k} 140 ${ym - k} 250 ${ym}`,
    `C 360 ${ym + k} 440 ${y2 - k} 480 ${y2}`,
    `L 480 ${y2 + w}`,
    `C 440 ${y2 + w - k} 360 ${ym + w + k} 250 ${ym + w}`,
    `C 140 ${ym + w - k} 60 ${y1 + w + k} -80 ${y1 + w}`,
    'Z',
  ].join(' ')
}

export interface CoverArt {
  /** 丝绸流体渐变（SVG data URI），可直接作为 CSS `background`。 */
  background: string
}

/**
 * 为一个 seed 生成封面图。
 *
 * @param seed 形如 `netease:12345` 的身份键（见 shared `keyOf`）；缺省时用固定值。
 */
export function coverArtFor(seed: string): CoverArt {
  const h = hashOf(seed || 'pterosaur')

  const fam = FAMILIES[Math.floor(unit(h, 1) * FAMILIES.length)]
  const sat = 62 + Math.round(unit(h, 2) * 16) // 62–78
  /** 以 0 为中心的确定性抖动，幅度 ±span。 */
  const jitter = (salt: number, span: number) =>
    Math.round((unit(h, salt) - 0.5) * 2 * span)
  const corner = CORNERS[Math.floor(unit(h, 3) * CORNERS.length)]

  // 三档明度：亮带远亮于深底（L 差 ≥ 25），才有「发光绸缎」的立体感；
  // 小图（列表行 44px）的辨识度也全靠这档明度差撑着。
  const brightL = 68 + Math.round(unit(h, 4) * 6) // 68–74
  const deepL = 15 + Math.round(unit(h, 5) * 5) // 15–20

  const base = hsl(fam.deep, sat - 8, deepL + 3)
  const deep = hsl(fam.deep, sat - 10, deepL)
  const main = hsl(fam.main, sat + 4, 50)
  const bright = hsl(fam.bright, sat + 10, brightL)
  const accent = hsl(fam.accent, 88, 62)

  // —— 主色带：厚、亮、S 形，亮端指向光斑角。波幅 48–92：太小是直带，太大波形碎。 ——
  const mY1 = 140 + jitter(20, 36)
  const mY2 = mY1 + jitter(21, 50)
  const mW = 140 + jitter(22, 30)
  const mainBand = band(mY1, mY2, mW, 48 + Math.round(unit(h, 23) * 44))
  const mainRot = corner.tilt + jitter(25, 18)

  // —— 副色带：更薄、近垂直地穿插（与主带差 ~90°），制造层叠 ——
  const sY1 = 190 + jitter(26, 40)
  const sY2 = sY1 + jitter(27, 60)
  const sW = 76 + jitter(28, 22)
  const subBand = band(sY1, sY2, sW, 44 + Math.round(unit(h, 29) * 40))
  const subRot = corner.tilt + 90 + jitter(30, 40)

  // —— 高光带：极淡的白，贴着主带方向加一层「反光」 ——
  const gY1 = 84 + jitter(32, 24)
  const glossBand = band(
    gY1,
    gY1 + jitter(33, 30),
    30,
    40 + Math.round(unit(h, 34) * 30),
  )
  const glossRot = corner.tilt + jitter(35, 16)

  // —— 暖色光斑：压在选定角上，径向晕开；半径放大让重糊后仍有存在感 ——
  const gX = corner.x + jitter(36, 26)
  const gY = corner.y + jitter(37, 26)
  const gRx = 195 + jitter(38, 25)
  const gRy = 175 + jitter(39, 25)

  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>`,
    `<defs>`,
    // 两档柔焦（是试出来的，不要随意改回去）：
    // - b1 轻糊色带：半径太大会把色带溶成「单色雾」，保住 S 形走向全靠这档小半径；
    // - b2 重糊光团：暗部团块 / 光斑本来就该无边无际地晕开，半径越大越丝绸。
    // 滤镜区域外扩 30%，避免形状在画布边被切平。
    `<filter id='b1' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='8'/></filter>`,
    `<filter id='b2' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='40'/></filter>`,
    // 主色带渐变：亮端（靠光斑一侧）浓、向对端渐隐；峰值推到 1 保小图可读
    `<linearGradient id='m' x1='0' y1='0' x2='1' y2='0'>`,
    `<stop offset='0' stop-color='${bright}' stop-opacity='0.85'/>`,
    `<stop offset='0.28' stop-color='${bright}' stop-opacity='1'/>`,
    `<stop offset='0.62' stop-color='${bright}' stop-opacity='0.55'/>`,
    `<stop offset='1' stop-color='${bright}' stop-opacity='0'/>`,
    `</linearGradient>`,
    // 副色带渐变：方向相反（x1=1），亮端落在另一侧
    `<linearGradient id='s' x1='1' y1='0' x2='0' y2='0'>`,
    `<stop offset='0' stop-color='${main}' stop-opacity='0.8'/>`,
    `<stop offset='0.55' stop-color='${main}' stop-opacity='0.42'/>`,
    `<stop offset='1' stop-color='${main}' stop-opacity='0'/>`,
    `</linearGradient>`,
    // 高光带：白色居中、两端渐隐
    `<linearGradient id='w' x1='0' y1='0' x2='1' y2='0'>`,
    `<stop offset='0' stop-color='#fff' stop-opacity='0'/>`,
    `<stop offset='0.5' stop-color='#fff' stop-opacity='0.16'/>`,
    `<stop offset='1' stop-color='#fff' stop-opacity='0'/>`,
    `</linearGradient>`,
    // 光斑：峰值收敛、中段过渡拉长 + 重糊，让它「融进」底色而不是浮在上面
    `<radialGradient id='g'>`,
    `<stop offset='0' stop-color='${accent}' stop-opacity='0.7'/>`,
    `<stop offset='0.6' stop-color='${accent}' stop-opacity='0.28'/>`,
    `<stop offset='1' stop-color='${accent}' stop-opacity='0'/>`,
    `</radialGradient>`,
    // vignette：中心透明、四角渐暗
    `<radialGradient id='v' cx='0.5' cy='0.5' r='0.75'>`,
    `<stop offset='0' stop-color='${deep}' stop-opacity='0'/>`,
    `<stop offset='0.6' stop-color='${deep}' stop-opacity='0'/>`,
    `<stop offset='1' stop-color='${deep}' stop-opacity='0.55'/>`,
    `</radialGradient>`,
    `</defs>`,
    // 1) 深色打底
    `<rect width='400' height='400' fill='${base}'/>`,
    // 2–5) 分组柔焦：暗部团块（重糊）→ 副带 / 主带（轻糊）→ 光斑（重糊）→ 高光（轻糊）
    `<ellipse cx='${400 - corner.x}' cy='${400 - corner.y}' rx='210' ry='190' fill='${deep}' opacity='0.9' filter='url(#b2)'/>`,
    `<path d='${subBand}' fill='url(#s)' transform='rotate(${subRot} 200 200)' filter='url(#b1)'/>`,
    `<path d='${mainBand}' fill='url(#m)' transform='rotate(${mainRot} 200 200)' filter='url(#b1)'/>`,
    `<ellipse cx='${gX}' cy='${gY}' rx='${gRx}' ry='${gRy}' fill='url(#g)' filter='url(#b2)'/>`,
    `<path d='${glossBand}' fill='url(#w)' transform='rotate(${glossRot} 200 200)' filter='url(#b1)'/>`,
    // 6) vignette 盖顶
    `<rect width='400' height='400' fill='url(#v)'/>`,
    `</svg>`,
  ].join('')

  // encodeURIComponent 会转义 <>'#% 等；SVG 内部统一用单引号，外层用双引号包住 url()。
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`

  return {
    background: `url("${uri}") center/cover no-repeat, ${base}`,
  }
}
