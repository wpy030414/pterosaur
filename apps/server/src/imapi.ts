import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeBurn, fakeProbe } from './imapiFake.js'

/**
 * Windows **IMAPI2 COM** 刻录封装（见 ADR-048）。
 *
 * 由 Node `spawn` 执行内嵌 PowerShell 脚本完成磁盘操作（COM 是 Windows 直接调用光驱的唯一
 * 系统级通道）：
 * - 脚本模板恒为 **ASCII-only**——PS 5.1 按 ANSI（中文系统为 GBK）解析 `.ps1` 文本，
 *   模板含中文会乱码甚至解析失败；错误只回**错误码**，中文文案在 Node 侧映射；
 * - 动态配置经 **UTF-8 JSON 文件**传递（`-ConfigPath`），免命令行转义与编码问题；
 * - 脚本首行显式 `[Console]::OutputEncoding = UTF8`（默认 gb2312）；
 * - 进度 / 结果经 stdout **JSON lines** 回传（`parsePsLine` 解析）。
 *
 * `PTEROSAUR_RIP_FAKE_BURN=1` 时整体委托 `imapiFake`（开发 / 测试的模拟刻录缝）。
 */

export interface DiscProbe {
  recorders: { id: string; product?: string }[]
  /** 光驱中是否有介质。 */
  mediaPresent: boolean
  /** 介质是否空白 / 可追加（可刻录的前提）。 */
  blank: boolean
  /** 介质配置标签（CD-R / CD-RW 等；未知为 `0x..`）。 */
  profile?: string
  /** 介质容量（字节，按介质档位估算）。 */
  capacityBytes?: number
  /** 是否为模拟刻录。 */
  simulated: boolean
}

export interface BurnRequest {
  mode: 'data' | 'audio'
  /** 已备好的暂存目录（data 模式：其下全部文件写入镜像）。 */
  stagingDir: string
  /** 卷标（已清洗为 ASCII 安全字符）。 */
  volumeLabel: string
  /** audio 模式：按轨序排列的 WAV 绝对路径。 */
  audioTracks?: string[]
}

/** PS 脚本经 stdout 回传的事件（JSON lines）。 */
export type PsEvent =
  | { event: 'log'; message: string }
  | { event: 'phase'; phase: string }
  | { event: 'done' }
  | { event: 'error'; code: string; detail?: string }

/** 错误码 → 中文文案（PS 侧只回码，文案集中在 Node 一处，便于按 HRESULT 对照修正）。 */
const PS_ERROR_MESSAGES: Record<string, string> = {
  unsupported_platform: '当前平台不支持直刻（仅 Windows）',
  config_unreadable: '刻录配置不可读',
  no_recorder: '未检测到刻录机',
  no_media: '光驱中未放入光盘（请放入空白 CD-R）',
  media_not_blank: '光盘非空白，请更换空白 CD-R',
  media_unsupported: '介质不受支持（请使用 CD-R / CD-RW）',
  burn_failed: '刻录写入失败',
}

/** 错误码 → 中文文案；携 detail 时附注（排障用）。 */
export function psErrorMessage(code: string, detail?: string): string {
  const base = PS_ERROR_MESSAGES[code] ?? '刻录失败'
  return detail ? `${base}（${detail}）` : base
}

/** 解析一行 stdout 为 PS 事件；非事件行返回 null（调用方仅告警、不致命）。 */
export function parsePsLine(line: string): PsEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const ev = o.event
  if (ev === 'log' && typeof o.message === 'string')
    return { event: 'log', message: o.message }
  if (ev === 'phase' && typeof o.phase === 'string')
    return { event: 'phase', phase: o.phase }
  if (ev === 'done') return { event: 'done' }
  if (ev === 'error' && typeof o.code === 'string')
    return {
      event: 'error',
      code: o.code,
      detail: typeof o.detail === 'string' ? o.detail : undefined,
    }
  return null
}

const PROBE_TIMEOUT_MS = 20_000

/** 是否启用模拟刻录（开发 / 测试缝）。 */
export function isFakeBurn(): boolean {
  return process.env.PTEROSAUR_RIP_FAKE_BURN === '1'
}

/**
 * 探测刻录机与介质状态。非 Windows 抛 `unsupported_platform`。
 * 无光驱不报错——返回空刻录机列表（capabilities 据此禁用实体分发）。
 */
export async function probeDisc(): Promise<DiscProbe> {
  if (isFakeBurn()) return fakeProbe()
  if (process.platform !== 'win32')
    throw new Error(psErrorMessage('unsupported_platform'))

  const ctlDir = await mkdtemp(join(tmpdir(), 'pterosaur-probe-'))
  try {
    const res = await runPs(PS_PROBE_SCRIPT, ctlDir, null, PROBE_TIMEOUT_MS)
    const payload = parseProbePayload(res.stdoutLines)
    if (!payload)
      throw new Error(
        `刻录能力探测失败${res.stderrTail ? `：${res.stderrTail.split('\n').pop()}` : ''}`,
      )
    return { ...payload, simulated: false }
  } finally {
    await rm(ctlDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 执行一次真实刻录。成功 resolve；失败抛**已映射为中文**的错误（含错误码语义）。
 * 开始写入前会**复检**介质（探测到刻录之间存在换盘窗口）。
 */
export async function burnDisc(
  req: BurnRequest,
  onEvent: (e: PsEvent) => void,
): Promise<void> {
  if (isFakeBurn()) return fakeBurn(req, onEvent)
  if (process.platform !== 'win32')
    throw new Error(psErrorMessage('unsupported_platform'))

  const ctlDir = await mkdtemp(join(tmpdir(), 'pterosaur-burn-ctl-'))
  try {
    const configPath = join(ctlDir, '__config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        mode: req.mode,
        stagingDir: req.stagingDir,
        volumeLabel: req.volumeLabel,
        audioTracks: req.audioTracks ?? [],
      }),
      'utf8',
    )

    // 持有点对象承接回调内赋值（回调里直接赋值的 let 会被 TS 流分析窄化为 null）
    const psState: { error: { code: string; detail?: string } | null } = {
      error: null,
    }
    const res = await runPs(
      PS_BURN_SCRIPT,
      ctlDir,
      configPath,
      0,
      (_line, ev) => {
        if (!ev) return
        if (ev.event === 'error') psState.error = ev
        onEvent(ev)
      },
    )
    if (psState.error)
      throw new Error(
        psErrorMessage(psState.error.code, psState.error.detail),
      )
    if (res.code !== 0)
      throw new Error(
        `刻录进程异常退出（code=${res.code}${res.stderrTail ? `；${res.stderrTail.split('\n').pop()}` : ''}）`,
      )
  } finally {
    await rm(ctlDir, { recursive: true, force: true }).catch(() => {})
  }
}

interface PsRunResult {
  code: number | null
  stdoutLines: string[]
  /** stderr 尾部（最多 20 行），供错误附注。 */
  stderrTail: string
}

/** 执行一次 PS 脚本（写入 ctlDir 下的临时 `.ps1`），按行回调 stdout。 */
function runPs(
  script: string,
  ctlDir: string,
  configPath: string | null,
  timeoutMs: number,
  onLine?: (line: string, ev: PsEvent | null) => void,
): Promise<PsRunResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(ctlDir, '__script.ps1')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ]
    if (configPath) args.push('-ConfigPath', configPath)

    void (async () => {
      let child
      try {
        // 模板为纯 ASCII，utf8 无 BOM 写入即可（PS 5.1 按 ANSI 解析也安全）
        await writeFile(scriptPath, script, 'utf8')
        child = spawn('powershell.exe', args, { windowsHide: true })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }

      const stdoutLines: string[] = []
      const stderrLines: string[] = []
      let pending = ''
      let timedOut = false
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              child.kill()
            }, timeoutMs)
          : null
      const done = (fn: () => void) => {
        if (timer) clearTimeout(timer)
        fn()
      }

      child.stdout.on('data', (buf: Buffer) => {
        pending += buf.toString('utf8')
        let i: number
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i).replace(/\r$/, '')
          pending = pending.slice(i + 1)
          if (line.trim()) {
            stdoutLines.push(line)
            onLine?.(line, parsePsLine(line))
          }
        }
      })
      child.stderr.on('data', (buf: Buffer) => {
        for (const l of buf.toString('utf8').split(/\r?\n/)) {
          if (!l.trim()) continue
          stderrLines.push(l)
          if (stderrLines.length > 20) stderrLines.shift()
        }
      })
      child.on('error', (e) => {
        done(() =>
          reject(new Error(`powershell 启动失败：${e.message}`)),
        )
      })
      child.on('close', (code) => {
        done(() => {
          if (timedOut) {
            reject(new Error('powershell 执行超时'))
            return
          }
          if (pending.trim()) {
            stdoutLines.push(pending)
            onLine?.(pending, parsePsLine(pending))
          }
          resolve({ code, stdoutLines, stderrTail: stderrLines.join('\n') })
        })
      })
    })()
  })
}

/** 从 probe 脚本输出提取探测载荷（取最后一行合法 JSON）。 */
function parseProbePayload(
  lines: string[],
): Omit<DiscProbe, 'simulated'> | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o !== 'object' || o === null) continue
    if (typeof o.error === 'string') throw new Error(o.error)
    if (!('recorders' in o || 'mediaPresent' in o)) continue
    const recorders = Array.isArray(o.recorders)
      ? (o.recorders as Record<string, unknown>[]).map((r) => ({
          id: String(r.id ?? ''),
          product: typeof r.product === 'string' ? r.product : undefined,
        }))
      : []
    return {
      recorders,
      mediaPresent: !!o.mediaPresent,
      blank: !!o.blank,
      profile: typeof o.profile === 'string' ? o.profile : undefined,
      capacityBytes:
        typeof o.capacityBytes === 'number' ? o.capacityBytes : undefined,
    }
  }
  return null
}

/*
 * ============================ PowerShell 脚本模板 ============================
 * 以下模板必须保持 **ASCII-only**（PS 5.1 按 ANSI 解析 `.ps1`），
 * 且不得出现 `${`（模板字符串插值转义）——所有变量引用一律用 `$name` 形态。
 */

/**
 * 探测脚本：枚举刻录机（取第一台的介质状态与配置档）。
 * IMAPI_FORMAT2_DATA_MEDIA_STATE：BLANK=0x1、APPENDABLE=0x2（其余位忽略）；
 * IMAPI_PROFILE_TYPE：CD-R=0x9、CD-RW=0xA。
 */
export const PS_PROBE_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

try {
  $recorders = @()
  $mediaPresent = $false
  $blank = $false
  $profile = $null
  $capacityBytes = $null

  $dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
  foreach ($id in $dm) {
    $rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $rec.InitializeDiscRecorder($id)
    $product = ("$($rec.VendorId) $($rec.ProductId)").Trim()
    $recorders += @{ id = "$id"; product = $product }

    if ($recorders.Count -eq 1) {
      $fmt = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
      $fmt.Recorder = $rec
      $status = [int]$fmt.CurrentMediaStatus
      if ($status -ne 0) {
        $mediaPresent = $true
        $blank = (($status -band 0x1) -ne 0) -or (($status -band 0x2) -ne 0)
        $profileId = [int]$fmt.CurrentProfileType
        switch ($profileId) {
          0x9 { $profile = 'CD-R'; $capacityBytes = 700MB }
          0xA { $profile = 'CD-RW'; $capacityBytes = 700MB }
          default { $profile = "0x" + $profileId.ToString('X') }
        }
      }
    }
  }

  Emit @{ recorders = $recorders; mediaPresent = $mediaPresent; blank = $blank; profile = $profile; capacityBytes = $capacityBytes }
} catch {
  Emit @{ error = $_.Exception.Message }
  exit 1
}
`

/**
 * 刻录脚本：data 模式走 MsftFileSystemImage（ISO+Joliet+UDF）→ MsftDiscFormat2Data.Write；
 * audio 模式走 MsftDiscFormat2TrackAtOnce（PrepareMedia → 逐轨 AddAudioTrack → ReleaseMedia）。
 * 写入前复检介质状态（探测与刻录之间可能换过盘）；只接受 CD-R / CD-RW（0x9 / 0xA）。
 */
export const PS_BURN_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }
function Fail($code, $detail) { Emit @{ event = 'error'; code = "$code"; detail = "$detail" }; exit 1 }

try {
  $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
} catch {
  Fail 'config_unreadable' $_.Exception.Message
}

try {
  $rec = $null
  $dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
  foreach ($id in $dm) {
    $candidate = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $candidate.InitializeDiscRecorder($id)
    $rec = $candidate
    break
  }
  if ($null -eq $rec) { Fail 'no_recorder' '' }

  $probe = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
  $probe.Recorder = $rec
  $status = [int]$probe.CurrentMediaStatus
  if ($status -eq 0) { Fail 'no_media' '' }
  if ((($status -band 0x1) -eq 0) -and (($status -band 0x2) -eq 0)) { Fail 'media_not_blank' ("status=" + $status) }
  $profileId = [int]$probe.CurrentProfileType
  if (($profileId -ne 0x9) -and ($profileId -ne 0xA)) { Fail 'media_unsupported' ("profile=" + $profileId) }

  if ($cfg.mode -eq 'data') {
    Emit @{ event = 'phase'; phase = 'preparing' }
    $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
    $fsi.FileSystemsToCreate = 7
    $fsi.VolumeName = "$($cfg.volumeLabel)"
    foreach ($f in Get-ChildItem -LiteralPath "$($cfg.stagingDir)" -File) {
      $fsi.Root.AddFile($f.FullName, $f.Name)
    }
    $image = $fsi.CreateResultImage()
    Emit @{ event = 'phase'; phase = 'writing' }
    $probe.Write($image.ImageStream)
  } else {
    Emit @{ event = 'phase'; phase = 'writing' }
    $toc = New-Object -ComObject IMAPI2.MsftDiscFormat2TrackAtOnce
    $toc.Recorder = $rec
    $toc.ClientName = 'Pterosaur'
    $toc.PrepareMedia()
    foreach ($wav in $cfg.audioTracks) {
      $stream = [System.IO.File]::OpenRead("$wav")
      try { $toc.AddAudioTrack($stream) } finally { $stream.Dispose() }
    }
    $toc.ReleaseMedia()
  }

  # Try to eject the disc so the user can take it out (best effort).
  try { $rec.EjectMedia() } catch { }
  Emit @{ event = 'done' }
  exit 0
} catch {
  Fail 'burn_failed' $_.Exception.Message
}
`
