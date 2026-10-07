import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  audioQuality,
  buildCassette,
  buildLyricFromSubtitles,
  buildParts,
  canonicalBiliImage,
  collectLoginCookies,
  decodeTitle,
  extractWbiKey,
  getLyric,
  isChineseLan,
  mixinKey,
  normalizeBilibiliTrack,
  parseDuration,
  parseSampleRate,
  pickAudio,
  pickSubtitleTracks,
  playlistTracks,
  rankAudioUrls,
  rawQueryValue,
  searchCassettes,
  searchSongs,
  signWbi,
} from '../../src/sources/bilibili.js'

describe('decodeTitle（去高亮标签 + 解码实体）', () => {
  it('去掉 <em> 高亮标签并解码常见实体', () => {
    expect(decodeTitle('<em class="keyword">周杰伦</em> 稻香 &amp; 晴天')).toBe(
      '周杰伦 稻香 & 晴天',
    )
    expect(decodeTitle('A &lt;B&gt; &quot;C&quot; &#39;D&#39;')).toBe(
      'A <B> "C" \'D\'',
    )
  })

  it('空串返回空串', () => {
    expect(decodeTitle('')).toBe('')
  })
})

describe('parseDuration', () => {
  it('mm:ss 与 h:mm:ss 均解析为秒', () => {
    expect(parseDuration('12:34')).toBe(754)
    expect(parseDuration('222:28')).toBe(222 * 60 + 28)
    expect(parseDuration('1:02:03')).toBe(3723)
  })

  it('缺失 / 非法返回 0', () => {
    expect(parseDuration(undefined)).toBe(0)
    expect(parseDuration('')).toBe(0)
    expect(parseDuration('abc')).toBe(0)
  })
})

describe('canonicalBiliImage', () => {
  it('协议相对与 http 补为 https', () => {
    expect(canonicalBiliImage('//i0.hdslb.com/bfs/a.jpg')).toBe(
      'https://i0.hdslb.com/bfs/a.jpg',
    )
    expect(canonicalBiliImage('http://i0.hdslb.com/bfs/a.jpg')).toBe(
      'https://i0.hdslb.com/bfs/a.jpg',
    )
  })

  it('i0–iN 镜像主机规范化到固定主机（免缓存碎片）', () => {
    expect(canonicalBiliImage('https://i2.hdslb.com/bfs/a.jpg')).toBe(
      'https://i0.hdslb.com/bfs/a.jpg',
    )
  })

  it('非 hdslb 主机与空值原样 / 空串', () => {
    expect(canonicalBiliImage('https://cdn.example.com/a.jpg')).toBe(
      'https://cdn.example.com/a.jpg',
    )
    expect(canonicalBiliImage(undefined)).toBe('')
    expect(canonicalBiliImage('not a url')).toBe('')
  })
})

describe('normalizeBilibiliTrack', () => {
  it('映射为共享 Track（id=bvid、封面规范化、时长转秒）', () => {
    const t = normalizeBilibiliTrack({
      bvid: 'BV1xx411c7mD',
      aid: 123,
      title: '<em>周杰伦</em> 稻香',
      author: '某 UP 主',
      pic: '//i0.hdslb.com/bfs/cover.jpg',
      duration: '03:45',
    })
    expect(t.source).toBe('bilibili')
    expect(t.id).toBe('BV1xx411c7mD')
    expect(t.title).toBe('周杰伦 稻香')
    expect(t.artist).toBe('某 UP 主')
    expect(t.album).toBe('')
    expect(t.cover).toBe('https://i0.hdslb.com/bfs/cover.jpg')
    expect(t.duration).toBe(225)
    expect(t.fee).toBe('free')
  })

  it('缺 bvid 时回落 aid，缺字段降级', () => {
    const t = normalizeBilibiliTrack({ aid: 999 })
    expect(t.id).toBe('999')
    expect(t.title).toBe('未知视频')
    expect(t.duration).toBe(0)
  })
})

describe('pickAudio（按档位挑码率）', () => {
  const audios = [
    { bandwidth: 43_962, id: 30216 },
    { bandwidth: 102_931, id: 30232 },
    { bandwidth: 203_786, id: 30280 },
  ]

  it('standard 取最低、exhigh 取最高', () => {
    expect(pickAudio(audios, 'standard')?.id).toBe(30216)
    expect(pickAudio(audios, 'exhigh')?.id).toBe(30280)
  })

  it('lossless / hires 在匿名档里取最高（有更高档则自然跟随）', () => {
    expect(pickAudio(audios, 'lossless')?.id).toBe(30280)
    expect(
      pickAudio([...audios, { bandwidth: 1_411_200, id: 30251 }], 'hires')?.id,
    ).toBe(30251)
  })

  it('空列表返回 undefined', () => {
    expect(pickAudio([], 'exhigh')).toBeUndefined()
  })
})

describe('rankAudioUrls（候选 CDN 排序：官方 upos 优先，mcdn 殿后）', () => {
  const mcdn = 'https://xy112x30x129x16xy.mcdn.bilivideo.cn/audio.m4s'
  const upos = 'https://upos-sz-mirrorcoso1.bilivideo.com/audio.m4s'
  const cn = 'https://upos-cn.bilivideo.cn/audio.m4s'
  const edge = 'https://h2i438c.edge.mountaintoys.cn/audio.m4s'

  it('upos 主 CDN 最前、mcdn 最后（第三方边缘居中）', () => {
    expect(rankAudioUrls([mcdn, edge, cn, upos])).toEqual([
      upos,
      cn,
      edge,
      mcdn,
    ])
  })

  it('去重，且同档保持相对顺序', () => {
    expect(rankAudioUrls([mcdn, upos, mcdn])).toEqual([upos, mcdn])
  })

  it('空数组与非法地址不抛错', () => {
    expect(rankAudioUrls([])).toEqual([])
    expect(rankAudioUrls(['not a url', upos])).toEqual([upos, 'not a url'])
  })
})

describe('buildParts（分P 一对多）', () => {
  const view = {
    bvid: 'BV1xx411c7mD',
    title: '视频标题',
    pic: '//i2.hdslb.com/bfs/cover.jpg',
    owner: { name: 'UP 主' },
    pages: [
      { cid: 111, page: 1, part: '第一段', duration: 100 },
      { cid: 222, page: 2, part: '第二段', duration: 200 },
    ],
  }

  it('多P：一页一项，id = `<bvid>:<cid>`，标题取分P名（不带 PXX· 前缀），封面统一为视频封面', () => {
    const parts = buildParts(view)
    expect(parts).toHaveLength(2)
    expect(parts[0].id).toBe('BV1xx411c7mD:111')
    expect(parts[1].id).toBe('BV1xx411c7mD:222')
    expect(parts[0].title).toBe('第一段')
    expect(parts[1].title).toBe('第二段')
    expect(parts[0].cover).toBe('https://i0.hdslb.com/bfs/cover.jpg')
    expect(parts[0].artist).toBe('UP 主')
    expect(parts[0].duration).toBe(100)
    expect(parts.every((p) => p.source === 'bilibili')).toBe(true)
  })

  it('多P 但分P 名缺失 → 回落视频标题；单P 标题取视频标题', () => {
    const parts = buildParts({
      ...view,
      pages: [
        { cid: 111, page: 1, duration: 100 },
        { cid: 222, page: 2, part: '   ', duration: 200 },
      ],
    })
    expect(parts[0].title).toBe('视频标题')
    expect(parts[1].title).toBe('视频标题')

    const single = buildParts({
      ...view,
      pages: [{ cid: 9, page: 1, part: '正片', duration: 60 }],
    })
    expect(single).toHaveLength(1)
    expect(single[0].title).toBe('视频标题')
    expect(single[0].id).toBe('BV1xx411c7mD:9')
  })

  it('缺 bvid / 无 pages → 空数组', () => {
    expect(buildParts(undefined)).toEqual([])
    expect(buildParts({ title: 'x' })).toEqual([])
    expect(buildParts({ bvid: 'BV1', pages: [] })).toEqual([])
  })
})

describe('buildCassette（磁带 = bilibili 的 Playlist）', () => {
  const view = {
    bvid: 'BV1xx411c7mD',
    title: '合集<em>标题</em>',
    pic: '//i2.hdslb.com/bfs/cover.jpg',
    owner: { name: 'UP 主' },
    desc: '  这是简介  ',
    stat: { view: 12345 },
    pages: [
      { cid: 111, page: 1, part: '第一段', duration: 100 },
      { cid: 222, page: 2, part: '第二段', duration: 200 },
    ],
  }

  it('映射为磁带：trackCount = 分P 数、creator = UP 主、标题去高亮、封面规范化', () => {
    expect(buildCassette(view)).toEqual({
      source: 'bilibili',
      id: 'BV1xx411c7mD',
      name: '合集标题', // <em> 已去
      cover: 'https://i0.hdslb.com/bfs/cover.jpg',
      creator: 'UP 主',
      description: '这是简介',
      playCount: 12345,
      trackCount: 2,
    })
  })

  it('单P → trackCount=1；缺 pages → trackCount 留空（而非 0，避免卡片误置灰）', () => {
    expect(
      buildCassette({ ...view, pages: [{ cid: 9, page: 1, duration: 10 }] })
        .trackCount,
    ).toBe(1)
    expect(
      buildCassette({ bvid: 'BV1', title: 'x' }).trackCount,
    ).toBeUndefined()
    expect(buildCassette(undefined).trackCount).toBeUndefined()
  })

  it('缺字段降级：标题回落、UP 主回落、无简介 / 播放量时留空', () => {
    const c = buildCassette({ bvid: 'BV1' })
    expect(c.name).toBe('未知视频')
    expect(c.creator).toBe('未知 UP 主')
    expect(c.description).toBeUndefined()
    expect(c.playCount).toBeUndefined()
  })
})

describe('searchCassettes（磁带搜索：逐条补分P 数）', () => {
  /** 最小响应替身：避开 jsdom 是否提供 `Response` 的环境差异。 */
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })
  const videoGroup = (bvids: string[]) => ({
    code: 0,
    data: {
      result: [
        {
          result_type: 'video',
          data: bvids.map((bvid, i) => ({
            bvid,
            title: `T${i}`,
            author: 'UP',
            pic: '//i1.hdslb.com/x.jpg',
            duration: '1:00',
          })),
        },
      ],
    },
  })
  const viewData = (bvid: string, pages: number) => ({
    code: 0,
    data: {
      bvid,
      title: `T-${bvid}`,
      pic: '//i1.hdslb.com/x.jpg',
      owner: { name: 'UP' },
      stat: { view: 42 },
      pages: Array.from({ length: pages }, (_, i) => ({
        cid: 100 + i,
        page: i + 1,
        part: `P${i + 1}`,
        duration: 10,
      })),
    },
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('每条结果补查 view → trackCount = 分P 数，并归一化为 Playlist', async () => {
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      if (url.includes('search/all/v2'))
        return Promise.resolve(jsonRes(videoGroup(['BV1', 'BV2'])))
      const m = /bvid=(BV\d+)/.exec(url)
      return Promise.resolve(
        jsonRes(viewData(m?.[1] ?? 'BV1', m?.[1] === 'BV2' ? 1 : 3)),
      )
    })
    const list = await searchCassettes('x')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      source: 'bilibili',
      id: 'BV1',
      name: 'T-BV1',
      trackCount: 3,
      creator: 'UP',
      playCount: 42,
    })
    expect(list[1]!.trackCount).toBe(1)
  })

  it('某条 view 失败 → 该项 trackCount 留空（不写 0）、回落搜索结果标题，其余不受影响', async () => {
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      if (url.includes('search/all/v2'))
        return Promise.resolve(jsonRes(videoGroup(['BVbad', 'BVok'])))
      if (url.includes('bvid=BVbad'))
        return Promise.resolve(jsonRes({ code: -404, message: '稿件不存在' }))
      return Promise.resolve(jsonRes(viewData('BVok', 2)))
    })
    const list = await searchCassettes('x')
    const bad = list.find((c) => c.id === 'BVbad')!
    expect(bad.trackCount).toBeUndefined() // 不写 0，否则 PlaylistCard 会置灰「播放」
    expect(bad.name).toBe('T0') // 回落搜索结果标题
    expect(list.find((c) => c.id === 'BVok')!.trackCount).toBe(2)
  })

  it('分P 补查受并发上限约束（同时在飞的 view 请求 ≤ 4）', async () => {
    const bvids = Array.from({ length: 8 }, (_, i) => `BV${i}`)
    let inflight = 0
    let max = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      if (url.includes('search/all/v2'))
        return Promise.resolve(jsonRes(videoGroup(bvids)))
      inflight++
      max = Math.max(max, inflight)
      const m = /bvid=(BV\d+)/.exec(url)
      return new Promise((resolve) =>
        setTimeout(() => {
          inflight--
          resolve(jsonRes(viewData(m?.[1] ?? 'BV0', 1)))
        }, 5),
      )
    })
    const list = await searchCassettes('x')
    expect(list).toHaveLength(8)
    expect(max).toBeLessThanOrEqual(4)
  })
})

describe('playlistTracks（磁带详情）', () => {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('一次 view → 磁带档案 + 分P 曲目（id 带分P 后缀也只取 bvid）', async () => {
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      return Promise.resolve(
        jsonRes({
          code: 0,
          data: {
            bvid: 'BV9',
            title: '磁带',
            pic: '//i1.hdslb.com/x.jpg',
            owner: { name: 'UP' },
            pages: [
              { cid: 100, page: 1, part: 'P1', duration: 10 },
              { cid: 101, page: 2, part: 'P2', duration: 20 },
            ],
          },
        }),
      )
    })
    const { playlist, tracks } = await playlistTracks('BV9:5')
    expect(playlist).toMatchObject({
      source: 'bilibili',
      id: 'BV9',
      trackCount: 2,
    })
    expect(tracks).toHaveLength(2)
    expect(tracks[0]!.id).toBe('BV9:100')
  })

  it('view 失败 → 向上抛（路由转 502，页面出错误态）', async () => {
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      return Promise.reject(new Error('net'))
    })
    await expect(playlistTracks('BVerr')).rejects.toThrow()
  })
})

describe('登录 cookie 收敛（保持原始编码，修「刷新掉登录」）', () => {
  it('rawQueryValue 不解码（%2C 原样保留）', () => {
    expect(
      rawQueryValue('https://x/l?SESSDATA=abc%2Cdef&x=1', 'SESSDATA'),
    ).toBe('abc%2Cdef')
    expect(rawQueryValue('https://x/l', 'SESSDATA')).toBeUndefined()
    expect(rawQueryValue('https://x/l?a=1', 'SESSDATA')).toBeUndefined()
  })

  it('collectLoginCookies：Set-Cookie 优先；缺失的从回跳 URL 补齐且**保持编码**', () => {
    const url =
      'https://www.bilibili.com/ok?SESSDATA=abc%2Cdef&bili_jct=www&gourl=x'
    const out = collectLoginCookies(['DedeUserID=123; Path=/'], url)
    expect(out).toContain('DedeUserID=123; Path=/')
    expect(out).toContain('SESSDATA=abc%2Cdef') // 未解码（解码成逗号会让浏览器拒存）
    expect(out).toContain('bili_jct=www')

    // 已由 Set-Cookie 给出的名字，不再从 URL 重复补
    const out2 = collectLoginCookies(['SESSDATA=fromheader'], url)
    expect(out2.filter((c) => c.startsWith('SESSDATA='))).toEqual([
      'SESSDATA=fromheader',
    ])
  })
})

describe('bGet 匿名解析重试', () => {
  /** 最小响应替身：避开 jsdom 是否提供 `Response` 的环境差异。 */
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('前两次网络失败、第三次成功 → 共 3 次请求且最终成功', async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      if (String(input).includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
      n++
      if (n <= 2) return Promise.reject(new Error('net'))
      return Promise.resolve(jsonRes({ code: 0, data: { result: [] } }))
    })
    const p = searchSongs('x')
    await vi.advanceTimersByTimeAsync(1200) // 覆盖 2 × 333ms
    await expect(p).resolves.toEqual([])
    expect(n).toBe(3)
  })

  it('上游返回非 0 业务码 → 同样重试（与具体错误码无关）', async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      if (String(input).includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
      n++
      if (n <= 2)
        return Promise.resolve(jsonRes({ code: -412, message: '风控' }))
      return Promise.resolve(jsonRes({ code: 0, data: { result: [] } }))
    })
    const p = searchSongs('x')
    await vi.advanceTimersByTimeAsync(1200)
    await expect(p).resolves.toEqual([])
    expect(n).toBe(3)
  })

  it('持续失败 → 重试至上限后抛错（首次 + 5 次重试 = 6 次请求）', async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      if (String(input).includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
      n++
      return Promise.reject(new Error('net'))
    })
    const p = searchSongs('x')
    const failed = expect(p).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(2000) // 覆盖 5 × 333ms
    await failed
    expect(n).toBe(6)
  })
})

describe('isChineseLan（中文语言族判定）', () => {
  it('zh / zh-CN / zh-Hans / zh-Hant / ai-zh 均算中文', () => {
    expect(isChineseLan('zh')).toBe(true)
    expect(isChineseLan('zh-CN')).toBe(true)
    expect(isChineseLan('zh-Hans')).toBe(true)
    expect(isChineseLan('zh-Hant')).toBe(true)
    expect(isChineseLan('ai-zh')).toBe(true)
  })

  it('en / ja / ai-en / 空值不算', () => {
    expect(isChineseLan('en')).toBe(false)
    expect(isChineseLan('ja')).toBe(false)
    expect(isChineseLan('ai-en')).toBe(false)
    expect(isChineseLan('')).toBe(false)
    expect(isChineseLan(undefined)).toBe(false)
  })
})

describe('pickSubtitleTracks（主语言 + 中文翻译选轨）', () => {
  const url = (n: number) => `//i0.hdslb.com/bfs/subtitle/${n}.json`

  it('双语模式：非中文人工轨为原文主轨（乔布斯案例：中文译轨排列表首位），锁定中文轨也不改', () => {
    const pick = pickSubtitleTracks([
      { lan: 'zh', type: 0, subtitle_url: url(1) },
      { lan: 'en', type: 0, subtitle_url: url(2) },
      { lan: 'ai-zh', type: 1, ai_type: 1, subtitle_url: url(3) },
    ])
    expect(pick?.main.lan).toBe('en')
    expect(pick?.zh?.lan).toBe('zh') // 人工中文优先于 AI

    // 即使 UP 锁定中文轨（现代数据罕见），原文轨仍优先——双语模式语义
    const locked = pickSubtitleTracks([
      { lan: 'en', type: 0, subtitle_url: url(1) },
      { lan: 'zh-CN', is_lock: true, subtitle_url: url(2) },
    ])
    expect(locked?.main.lan).toBe('en')
    expect(locked?.zh?.lan).toBe('zh-CN')
  })

  it('仅中文轨（华语视频 / 仅 ai-zh 的外语视频）→ 中文单语，不叠翻译', () => {
    const onlyAiZh = pickSubtitleTracks([
      { lan: 'ai-zh', type: 1, ai_type: 1, ai_status: 2, subtitle_url: url(1) },
    ])
    expect(onlyAiZh?.main.lan).toBe('ai-zh')
    expect(onlyAiZh?.zh).toBeUndefined()

    const lockedZhOnly = pickSubtitleTracks([
      { lan: 'zh-CN', is_lock: true, subtitle_url: url(1) },
    ])
    expect(lockedZhOnly?.main.lan).toBe('zh-CN')
    expect(lockedZhOnly?.zh).toBeUndefined()
  })

  it('主轨非中文 → 叠中文翻译，人工 CC 优先于 AI 字幕', () => {
    const pick = pickSubtitleTracks([
      { lan: 'ja', is_lock: true, subtitle_url: url(1) },
      { lan: 'ai-zh', ai_type: 1, subtitle_url: url(2) },
      { lan: 'zh-CN', subtitle_url: url(3) },
    ])
    expect(pick?.main.lan).toBe('ja')
    expect(pick?.zh?.lan).toBe('zh-CN')
  })

  it('`type=1` 即判 AI（缺 ai_type / ai- 前缀也能识别），AI 轨不作原文候选', () => {
    const pick = pickSubtitleTracks([
      { lan: 'ai-en', type: 1, subtitle_url: url(1) },
      { lan: 'ai-zh', type: 1, subtitle_url: url(2) },
    ])
    expect(pick?.main.lan).toBe('ai-en') // 无人工原文轨 → 回落列表首条
    expect(pick?.zh?.lan).toBe('ai-zh')
  })

  it('仅剩 AI 中文时 AI 兜底；完全无中文则只出主语言', () => {
    const aiOnly = pickSubtitleTracks([
      { lan: 'en', subtitle_url: url(1) },
      { lan: 'ai-zh', ai_type: 1, subtitle_url: url(2) },
    ])
    expect(aiOnly?.zh?.lan).toBe('ai-zh')

    const none = pickSubtitleTracks([
      { lan: 'en', is_lock: true, subtitle_url: url(1) },
      { lan: 'ja', subtitle_url: url(2) },
    ])
    expect(none?.main.lan).toBe('en')
    expect(none?.zh).toBeUndefined()
  })

  it('无锁定轨取列表首条；无 subtitle_url 的轨不参与，全无可用返回 null', () => {
    const noLock = pickSubtitleTracks([
      { lan: 'ko', subtitle_url: url(1) },
      { lan: 'en', subtitle_url: url(2) },
    ])
    expect(noLock?.main.lan).toBe('ko')

    expect(pickSubtitleTracks([{ lan: 'en' }, { lan: 'ai-zh' }])).toBeNull()
    expect(pickSubtitleTracks([])).toBeNull()
  })
})

describe('buildLyricFromSubtitles（字幕 → 歌词 + 时间窗重叠对齐）', () => {
  it('主轨映射为带时间轴歌词，正文空白折叠为单行', () => {
    const lyric = buildLyricFromSubtitles([
      { from: 0, to: 2, content: 'Hello\n  world' },
      { from: 2.5, to: 4, content: 'Again' },
    ])
    expect(lyric.timed).toBe(true)
    expect(lyric.lines).toEqual([
      { time: 0, text: 'Hello world' },
      { time: 2.5, text: 'Again' },
    ])
  })

  it('中文轨按时间窗重叠对齐为 translation', () => {
    const lyric = buildLyricFromSubtitles(
      [
        { from: 0, to: 2, content: 'Hello' },
        { from: 2, to: 4, content: 'World' },
      ],
      [
        { from: 0.2, to: 1.8, content: '你好' },
        { from: 2.1, to: 3.9, content: '世界' },
      ],
    )
    expect(lyric.lines[0].translation).toBe('你好')
    expect(lyric.lines[1].translation).toBe('世界')
  })

  it('分段不一致：一句中文跨两句原文归首句；两句中文叠一句原文以空格连接', () => {
    const oneToMany = buildLyricFromSubtitles(
      [
        { from: 0, to: 2, content: 'A' },
        { from: 2, to: 4, content: 'B' },
      ],
      [{ from: 0, to: 4, content: 'AB 整句' }],
    )
    expect(oneToMany.lines[0].translation).toBe('AB 整句')
    expect(oneToMany.lines[1].translation).toBeUndefined()

    const manyToOne = buildLyricFromSubtitles(
      [{ from: 0, to: 4, content: 'long line' }],
      [
        { from: 0, to: 2, content: '前半' },
        { from: 2, to: 4, content: '后半' },
      ],
    )
    expect(manyToOne.lines[0].translation).toBe('前半 后半')
  })

  it('最大重叠挂载：一句中文跨两句原文时挂重叠更长者（并列取更早），而非首个重叠行', () => {
    const lyric = buildLyricFromSubtitles(
      [
        { from: 0, to: 2, content: 'A' },
        { from: 2, to: 4, content: 'B' },
      ],
      // 与 A 重叠 0.1s、与 B 重叠 1.9s → 应挂 B
      [{ from: 1.9, to: 3.9, content: '偏后' }],
    )
    expect(lyric.lines[0].translation).toBeUndefined()
    expect(lyric.lines[1].translation).toBe('偏后')
  })

  it('两轨分段一致（同作者逐句对照）→ 自然退化为逐行精确配对', () => {
    const lyric = buildLyricFromSubtitles(
      [
        { from: 1.55, to: 2.89, content: 'Thank you.' },
        { from: 8.02, to: 9.751, content: "I'm honored to be with you" },
      ],
      [
        { from: 1.55, to: 2.89, content: '谢谢。' },
        { from: 8.02, to: 10.591, content: '今天能与你们共同庆祝' },
      ],
    )
    expect(lyric.lines[0].translation).toBe('谢谢。')
    expect(lyric.lines[1].translation).toBe('今天能与你们共同庆祝')
  })

  it('落在原文间隙的中文行丢弃；字符串型 from/to 容错', () => {
    const lyric = buildLyricFromSubtitles(
      [
        { from: 0, to: 2, content: 'A' },
        { from: 4, to: 6, content: 'B' },
      ],
      [
        { from: 2.5, to: 3.5, content: '间隙' },
        { from: '4.1', to: '5.9', content: '第二句' },
      ],
    )
    expect(lyric.lines[0].translation).toBeUndefined()
    expect(lyric.lines[1].translation).toBe('第二句')
  })

  it('空主轨 / 全空行 → 无时间轴空歌词', () => {
    expect(buildLyricFromSubtitles([])).toEqual({ lines: [], timed: false })
    expect(buildLyricFromSubtitles([{ from: 1, to: 2, content: '' }])).toEqual({
      lines: [],
      timed: false,
    })
  })
})

describe('wbi 签名（密钥取自 nav.wbi_img，供 player/wbi/v2）', () => {
  // bilibili-API-collect 官方示例密钥（各 32 位）
  const IMG = '7cd084941338484aae1ad9425b84077c'
  const SUB = '4932caff0ff74675bde1a2150ae2feb4'

  it('extractWbiKey：取 URL 文件名去后缀；空值安全', () => {
    expect(extractWbiKey(`https://i0.hdslb.com/bfs/wbi/${IMG}.png`)).toBe(IMG)
    expect(extractWbiKey(undefined)).toBe('')
    expect(extractWbiKey('')).toBe('')
  })

  it('mixinKey：盐表混淆取前 32 位（golden＝官方示例）', () => {
    expect(mixinKey(IMG, SUB)).toBe('751d2124ae3ce062474d93fa704f4ff8')
  })

  it('signWbi：滤空值、按键排序、追加 wts；w_rid = md5(query + key)', () => {
    const q = signWbi(
      { foo: '114', bar: '514', baz: 1919810, empty: '' },
      mixinKey(IMG, SUB),
      1702204800,
    )
    expect(q).toBe(
      'bar=514&baz=1919810&foo=114&wts=1702204800&w_rid=8865601c239c409886f29b2e14186f15',
    )
  })
})

describe('getLyric（字幕 → 歌词，端到端桩）', () => {
  /** 最小响应替身：避开环境是否提供 `Response` 的差异。 */
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })
  const IMG = '7cd084941338484aae1ad9425b84077c'
  const SUB = '4932caff0ff74675bde1a2150ae2feb4'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录态：主轨非中文 + 中文翻译 → 双语歌词；`bvid:cid` 免 pagelist 且带 cookie', async () => {
    const urls: string[] = []
    let cookieSeen = ''
    vi.stubGlobal(
      'fetch',
      (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input)
        urls.push(url)
        if (init?.headers?.Cookie) cookieSeen = init.headers.Cookie
        if (url.includes('/finger/spi'))
          return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
        if (url.includes('/web-interface/nav'))
          return Promise.resolve(
            jsonRes({
              code: 0,
              data: {
                wbi_img: {
                  img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`,
                  sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png`,
                },
              },
            }),
          )
        if (url.includes('/player/wbi/v2'))
          return Promise.resolve(
            jsonRes({
              code: 0,
              data: {
                subtitle: {
                  subtitles: [
                    {
                      lan: 'en',
                      is_lock: true,
                      subtitle_url: '//i0.hdslb.com/bfs/subtitle/en.json',
                    },
                    {
                      lan: 'zh-CN',
                      subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json',
                    },
                  ],
                },
              },
            }),
          )
        if (url.includes('subtitle/en.json'))
          return Promise.resolve(
            jsonRes({ body: [{ from: 0, to: 2, content: 'Hello' }] }),
          )
        if (url.includes('subtitle/zh.json'))
          return Promise.resolve(
            jsonRes({ body: [{ from: 0.1, to: 1.9, content: '你好' }] }),
          )
        return Promise.reject(new Error(`unexpected url: ${url}`))
      },
    )

    const lyric = await getLyric('BV1xx411c7mD:42', 'SESSDATA=xxx')
    expect(lyric).toEqual({
      lines: [{ time: 0, text: 'Hello', translation: '你好' }],
      timed: true,
    })
    // 已带 cid → 不再查 pagelist；wbi 签名版通道；凭证透传
    expect(urls.some((u) => u.includes('pagelist'))).toBe(false)
    expect(urls.some((u) => u.includes('wbi/v2') && u.includes('w_rid='))).toBe(
      true,
    )
    expect(cookieSeen).toContain('SESSDATA=xxx')
  })

  it('匿名（subtitles 恒空）→ 空歌词；纯 bvid 经 pagelist 取首P', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
      if (url.includes('/web-interface/nav'))
        return Promise.resolve(
          jsonRes({
            code: 0,
            data: {
              wbi_img: {
                img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`,
                sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png`,
              },
            },
          }),
        )
      if (url.includes('/player/pagelist'))
        return Promise.resolve(jsonRes({ code: 0, data: [{ cid: 42 }] }))
      if (url.includes('/player/wbi/v2'))
        return Promise.resolve(
          jsonRes({ code: 0, data: { subtitle: { subtitles: [] } } }),
        )
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })

    const lyric = await getLyric('BV1xx411c7mD')
    expect(lyric).toEqual({ lines: [], timed: false })
    expect(urls.some((u) => u.includes('pagelist'))).toBe(true)
  })

  it('双语模式（乔布斯案例形态）：人工中文轨排首 + 英文轨 → 英文为主、中文为译', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'buvid' } }))
      if (url.includes('/web-interface/nav'))
        return Promise.resolve(
          jsonRes({
            code: 0,
            data: {
              wbi_img: {
                img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`,
                sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png`,
              },
            },
          }),
        )
      if (url.includes('/player/wbi/v2'))
        return Promise.resolve(
          jsonRes({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    // 实测形态：UP 把中文译轨排在英文原文轨之前，且均无锁定
                    lan: 'zh',
                    type: 0,
                    subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json',
                  },
                  {
                    lan: 'en',
                    type: 0,
                    subtitle_url: '//i0.hdslb.com/bfs/subtitle/en.json',
                  },
                  {
                    lan: 'ai-zh',
                    type: 1,
                    ai_type: 1,
                    ai_status: 2,
                    subtitle_url: '//i0.hdslb.com/bfs/subtitle/ai.json',
                  },
                ],
              },
            },
          }),
        )
      if (url.includes('subtitle/en.json'))
        return Promise.resolve(
          jsonRes({ body: [{ from: 0, to: 2, content: 'Thank you.' }] }),
        )
      if (url.includes('subtitle/zh.json'))
        return Promise.resolve(
          jsonRes({ body: [{ from: 0, to: 2, content: '谢谢。' }] }),
        )
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })

    const lyric = await getLyric('BV1xx411c7mD:42')
    expect(lyric).toEqual({
      lines: [{ time: 0, text: 'Thank you.', translation: '谢谢。' }],
      timed: true,
    })
    // AI 中文轨不应被拉取（人工中文优先）
    expect(urls.some((u) => u.includes('subtitle/ai.json'))).toBe(false)
  })
})

/* ---- 采样率探测（B 站 playurl 不回报 sr，读 fMP4 文件头） ---- */

/** 构造一个 MP4 box：`[size:4][type:4][payload]`。 */
const mp4Box = (type: string, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + payload.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

const joinBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** AudioSampleEntry 载荷（28 字节）：采样率以 16.16 定点写在偏移 24 处。 */
const audioEntry = (sr: number, fmt = 'mp4a'): Uint8Array => {
  const p = new Uint8Array(28)
  new DataView(p.buffer).setUint16(16, 2) // channelcount 占位
  new DataView(p.buffer).setUint32(24, sr * 65536)
  return mp4Box(fmt, p)
}

/** 最小音频 init segment：`ftyp + moov{ mvhd, trak{ mdia{ minf{ stbl{ stsd{ entry } } } } } }`。 */
const initSegment = (entry: Uint8Array): Uint8Array =>
  joinBytes([
    mp4Box('ftyp', new Uint8Array(8)),
    mp4Box(
      'moov',
      joinBytes([
        mp4Box('mvhd', new Uint8Array(20)),
        mp4Box(
          'trak',
          mp4Box(
            'mdia',
            mp4Box(
              'minf',
              mp4Box(
                'stbl',
                mp4Box('stsd', joinBytes([new Uint8Array(8), entry])),
              ),
            ),
          ),
        ),
      ]),
    ),
  ])

describe('parseSampleRate（fMP4 init segment 解析采样率）', () => {
  it('44100 / 48000 均从 stsd 首个 AudioSampleEntry 解出（16.16 定点取高 16 位）', () => {
    expect(parseSampleRate(initSegment(audioEntry(44100)))).toBe(44100)
    expect(parseSampleRate(initSegment(audioEntry(48000)))).toBe(48000)
  })

  it('stsd 首个 entry 非音频格式（如 avc1）→ undefined', () => {
    expect(
      parseSampleRate(initSegment(audioEntry(48000, 'avc1'))),
    ).toBeUndefined()
  })

  it('乱字节 / 截断 / 空 → undefined 且不抛错', () => {
    expect(parseSampleRate(new Uint8Array(0))).toBeUndefined()
    expect(parseSampleRate(new Uint8Array(64).fill(0x5a))).toBeUndefined()
    expect(
      parseSampleRate(initSegment(audioEntry(48000)).slice(0, 12)),
    ).toBeUndefined()
  })
})

describe('audioQuality 采样率探测（回源读头 + 进程内缓存）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })

  /** 打桩上游三段式：finger/spi + pagelist + playurl，CDN 部分由各用例自定义。 */
  const stubApi = (
    cdn: (url: string, init?: RequestInit) => Promise<unknown>,
  ) => {
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/finger/spi'))
        return Promise.resolve(jsonRes({ code: 0, data: { b_3: 'b' } }))
      if (url.includes('pagelist'))
        return Promise.resolve(jsonRes({ code: 0, data: [{ cid: 7 }] }))
      if (url.includes('playurl'))
        return Promise.resolve(
          jsonRes({
            code: 0,
            data: {
              dash: {
                audio: [
                  {
                    id: 30280,
                    bandwidth: 204000,
                    codecs: 'mp4a.40.2',
                    mimeType: 'audio/mp4',
                    baseUrl: 'https://upos-sz-mirror.bilivideo.com/a.m4s',
                    backupUrl: ['https://upcdn.mcdn.bilivideo.cn/a.m4s'],
                  },
                ],
              },
            },
          }),
        )
      return cdn(url, init)
    })
  }

  it('官方 CDN 403 → 回退 mcdn 候选仍解出 sr；二次调用命中缓存不再回源', async () => {
    const seg = initSegment(audioEntry(48000))
    let cdnHits = 0
    let sawRange = ''
    stubApi((url, init) => {
      if (url.includes('upos-sz-mirror'))
        return Promise.resolve({ ok: false, status: 403 })
      cdnHits++
      sawRange = String(
        (init?.headers as Record<string, string> | undefined)?.Range ?? '',
      )
      return Promise.resolve({
        ok: true,
        status: 206,
        arrayBuffer: () => Promise.resolve(seg.buffer),
      })
    })
    const id = 'BV1srProbeA'
    await expect(audioQuality(id, undefined, 'exhigh')).resolves.toEqual({
      codec: 'AAC',
      br: 204000,
      sr: 48000,
    })
    expect(cdnHits).toBe(1)
    expect(sawRange).toMatch(/^bytes=0-/) // 只拉前缀，不取整文件
    // 二次展示：进程内缓存生效，CDN 不再被请求
    await expect(audioQuality(id, undefined, 'exhigh')).resolves.toEqual({
      codec: 'AAC',
      br: 204000,
      sr: 48000,
    })
    expect(cdnHits).toBe(1)
  })

  it('CDN 全部 403 → sr 缺席，码率/编解码照常展示', async () => {
    stubApi(() => Promise.resolve({ ok: false, status: 403 }))
    await expect(
      audioQuality('BV1srProbeB', undefined, 'exhigh'),
    ).resolves.toEqual({
      codec: 'AAC',
      br: 204000,
    })
  })
})
