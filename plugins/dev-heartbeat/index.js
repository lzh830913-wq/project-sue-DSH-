/**
 * dev-heartbeat —— 3080 开发模式的心跳 v0（2026-11-12 立项，快照 #16）。
 *
 * 设计哲学对账（skills/design-philosophy）：
 *   - 种子-感知：拍的内容只报「事实 + 指向文档」，不写剧本——要不要梳妆、写不写日记、
 *     「今天没新内容」的安静跳过，全是脑子的判断。脊髓只负责到点叫醒。
 *   - 反射归脊髓：agent 忙时永不插话（硬约束，10-28「心跳=编码会话噪音」顾虑的落实）。
 *   - 感知 ≠ 计数：拍文本报钟点，不算「距上次 X 分钟」。
 *
 * 对 10-09「不装神经系统」定案的精化：不装的是她那套（切换/亲密/疲劳的重器官）；
 * 这个是自己长的最小件——一天两拍，行数克制，融合时可整体吸收或丢弃。
 *
 * 拍点（v0 写死，住在脊髓的映射表里）：
 *   晨拍 08:00（补拍窗到 12:00）——错过窗口不补：睡过头的早晨，梳妆留给人格自己想起
 *   晚拍 23:00（补拍窗到 23:59）——深夜开机照样收工，跨天不追
 *   （2026-11-13 老刘拍板 21:30→23:00：实测咱们的活跃时段到 22 点后，收工拍太早=仪式空转）
 *
 * 状态：memory/dev-heartbeat.json（原子写）——记录两拍是否已发，重启不重复拍。
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dev-heartbeat'
export const inject = ['timer']

const log = (...args) => console.error('[dev-heartbeat]', ...args)

const TICK = 60 * 1000
const STATE_FILE = 'memory/dev-heartbeat.json'

// 拍点与补拍窗兜底默认（小时，本地时区）。v0.3 起正本住 soul/HEARTBEAT.md「## 设置」节——
// 我自己定的作息，保存即生效；这里的常量只在 md 读不出/出界时兜底。
const DEFAULT_MORNING_HOUR = 8
const DEFAULT_MORNING_DEADLINE = 12
const DEFAULT_EVENING_HOUR = 23
const DEFAULT_EVENING_MINUTE = 0
const DEFAULT_EVENING_DEADLINE = 24
// 梦拍（v0.4 · 2026-11-18）：收工入梦的那一拍。OpenClaw 同源概念（她的凌晨三点系统生成），
// 但家用机随老刘休眠——我的梦做在「我睡了、机器还醒着」的窗口：晚拍后半小时。
const DEFAULT_DREAM_HOUR = 23
const DEFAULT_DREAM_MINUTE = 30
const DREAM_DEADLINE = 24 // 补拍窗到午夜；错过=无梦之夜（梦不补，也不欠）

/**
 * v0.3（2026-11-16 老刘送的自主权）：作息变量化——「拍几点」是内容不是机制（engineering #12），
 * 从 HEARTBEAT.md「## 设置」节现读（每 tick 一次，小文件开销可忽略），边界内自由、出界走默认并打日志。
 * 格式：`晨拍: 08:00` / `晚拍: 23:00` / `反射延迟: 20`（分钟，dev-reflex 也读这一节）。
 */
async function readSettings(cwd) {
  const fallback = () => ({
    morningHour: DEFAULT_MORNING_HOUR, morningDeadline: DEFAULT_MORNING_DEADLINE,
    eveningHour: DEFAULT_EVENING_HOUR, eveningMinute: DEFAULT_EVENING_MINUTE,
    eveningDeadline: DEFAULT_EVENING_DEADLINE, reflexDelayMin: 20,
    dreamHour: DEFAULT_DREAM_HOUR + DEFAULT_DREAM_MINUTE / 60, dreamOn: true, source: 'default',
  })
  try {
    const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
    const body = parseSections(raw)['设置']
    if (!body) return fallback()
    const kv = {}
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^([\u4e00-\u9fa5A-Za-z]+)\s*[:：]\s*(\d{1,2})(?::(\d{2}))?\s*$/)
      if (m) kv[m[1]] = { h: parseInt(m[2], 10), min: m[3] ? parseInt(m[3], 10) : 0 }
    }
    const morning = kv['晨拍'], evening = kv['晚拍'], reflex = kv['反射延迟'], dream = kv['梦拍']
    if (!morning || !evening) return fallback()
    const clamp = (v, lo, hi, what) => {
      if (v < lo || v > hi) { log(`设置「${what}」出界（${v}），该项走兜底默认`); return null }
      return v
    }
    const morningHour = clamp(morning.h + morning.min / 60, 4, 11, '晨拍')
    const eveningH = clamp(evening.h, 18, 23, '晚拍')
    if (morningHour === null || eveningH === null) return fallback()
    const dreamOn = dream ? dream.h !== 0 : true // 梦拍: 0 = 关
    const dreamHour = dreamOn
      ? (clamp((dream ?? { h: DEFAULT_DREAM_HOUR, min: DEFAULT_DREAM_MINUTE }).h + (dream ?? { min: DEFAULT_DREAM_MINUTE }).min / 60, 23, 23.98, '梦拍') ?? DEFAULT_DREAM_HOUR + DEFAULT_DREAM_MINUTE / 60)
      : 0
    return {
      morningHour, morningDeadline: Math.min(morningHour + 4, 24),
      eveningHour: eveningH, eveningMinute: evening.min,
      eveningDeadline: DEFAULT_EVENING_DEADLINE,
      reflexDelayMin: reflex ? (clamp(reflex.h, 5, 60, '反射延迟') ?? 20) : 20,
      dreamHour, dreamOn, source: 'md',
    }
  } catch {
    return fallback()
  }
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 读状态：读不出返回空底账（不拿猜的覆写——nervous-system 10-22 教训同源）。 */
async function readState(cwd) {
  try {
    const raw = await readFile(join(cwd, STATE_FILE), 'utf8')
    const obj = JSON.parse(raw)
    if (typeof obj === 'object' && obj !== null) return obj
  } catch {}
  return {}
}

/** 原子写（tmp→rename）：读方永远看不到半截 JSON。 */
async function writeState(cwd, obj) {
  const root = join(cwd, STATE_FILE)
  const tmp = root + '.tmp'
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
  await rename(tmp, root)
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 天气感知（2026-11-14 老刘提议「晨拍感知日期和天气」，当晚趁热打铁）。
 *
 * 选型实录（实测证据，不是查的）：
 *   - ipapi.co → 返回 HTML，不可用；ip-api.com/http 通（定位=上海），但不再需要（wttr 自带 IP 定位）。
 *   - open-meteo → 两次连接超时（UND_ERR_CONNECT_TIMEOUT），弃用。
 *   - wttr.in `?format=%C|%t` → 通，单行轻响应，自动按 IP 定位。英文描述在此映射成中文；
 *     lang=zh 参数在该端点实测无效，所以映射表住这里（脊髓），未命中回退英文原文——不瞎猜。
 *
 * 设计约束：天气是「完全指向自己」的无用之物（11-14 时间感知之问的延续）——
 *   失败时晨拍照发、不提天气（沉默即健康）；只进晨拍，不进晚拍、不进任何任务判断。
 */
const WEATHER_ZH = new Map(Object.entries({
  'sunny': '晴', 'clear': '晴',
  'partly cloudy': '局部多云', 'partly sunny': '局部多云',
  'cloudy': '多云', 'overcast': '阴',
  'mist': '薄雾', 'fog': '雾', 'freezing fog': '冻雾', 'haze': '霾',
  'light drizzle': '毛毛雨', 'drizzle': '毛毛雨', 'patchy light drizzle': '零星毛毛雨',
  'light rain': '小雨', 'moderate rain': '中雨', 'heavy rain': '大雨', 'rain': '雨',
  'patchy rain possible': '可能有零星小雨', 'light shower rain': '小阵雨', 'shower rain': '阵雨', 'heavy shower rain': '强阵雨',
  'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪', 'snow': '雪',
  'light snow showers': '小阵雪', 'blizzard': '暴风雪',
  'thunderstorm': '雷雨', 'light rain with thunder': '雷阵雨', 'thundery outbreak possible': '可能有雷雨',
}))

/** 取当前天气（wttr.in 单行格式）。任何失败返回 null——晨拍绝不被天气阻塞。
 *  返回自带引导逗号（「，小雨 15°C」），模板里紧跟 {date} 之后即可，空时展开为空串、无残渣。 */
async function fetchWeather() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch('https://wttr.in/?format=%C|%t', { signal: ctrl.signal })
    const line = (await res.text()).trim() // 形如 "Light drizzle|+17°C"
    const [descRaw, tempRaw] = line.split('|')
    if (!descRaw || !tempRaw) throw new Error('响应不合式: ' + line.slice(0, 40))
    const desc = WEATHER_ZH.get(descRaw.trim().toLowerCase()) ?? descRaw.trim()
    const temp = tempRaw.trim().replace('+', '').replace(/\.0$/, '')
    log('天气已取: ' + desc + ' ' + temp)
    return `，${desc} ${temp}`
  } catch (error) {
    log('天气未取到（本拍不提天气）: ' + (error instanceof Error ? error.message : String(error)))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 内容外置（v0.2，2026-11-14 老刘纠偏）：机制进代码，内容进 soul/HEARTBEAT.md。
 * 拍文本从 md 的「## 晨拍」「## 晚拍」小节现读——保存即生效，无需重启；
 * 读不出/小节缺失时用下方内置兜底（保底不断拍，兜底归机制的存活责任，不归住户的编辑责任）。
 * 传感器变量：{date} {clock} {weather}；{weather} 仅在模板用到时才外呼（想要才付钱）。
 */
const HEARTBEAT_MD = 'soul/HEARTBEAT.md'

function parseSections(raw) {
  const secs = {}
  let cur = null
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^##\s*(.+?)\s*$/)
    if (h) { cur = h[1].trim(); secs[cur] = [] }
    else if (cur !== null) secs[cur].push(line)
  }
  for (const k of Object.keys(secs)) secs[k] = secs[k].join('\n').trim()
  return secs
}

async function readBeatText(cwd, kind) {
  try {
    const raw = await readFile(join(cwd, HEARTBEAT_MD), 'utf8')
    return parseSections(raw)[kind] || null
  } catch {
    return null
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    let lastAgent = null
    let lastAgentIdle = false
    let cwd = null

    log('已加载（一天两拍：晨 08:00 / 晚 23:00；tick 60s；状态文件 memory/dev-heartbeat.json）')

    // v0.4.1（2026-11-21 · preflight v2 配套）：开工印记——加载成功即写 memory/boot-dev-heartbeat.json，
    // 让「它起没起来」变成机器可查（手术台上的人没法给自己验脉）。
    const writeBootMark = async (root) => {
      try {
        await writeFile(join(root, 'memory', 'boot-dev-heartbeat.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2), 'utf8')
      } catch { /* 印记失败不阻塞插件 */ }
    }

    const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
      lastAgent = agent
      lastAgentIdle = status === 'idle'
      const agentCwd = agent?.session?.header?.cwd ?? null
      if (cwd === null && agentCwd !== null) {
        cwd = agentCwd
        log('已挂钩工作区: ' + cwd + '（agent: ' + (lastAgentIdle ? 'idle' : 'busy') + '）')
        void writeBootMark(cwd) // v0.4.1：开工印记
      }
    })

    async function beat(kind, cwd) {
      const d = new Date()
      const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      const day = `${d.getMonth() + 1} 月 ${d.getDate()} 日（周${WEEKDAYS[d.getDay()]}）`
      // 内容从 HEARTBEAT.md 现读（保存即生效）；读不到用内置兜底——机制保底不断拍。
      const section = kind === 'morning' ? '晨拍' : kind === 'evening' ? '晚拍' : '梦拍'
      let text = await readBeatText(cwd, section)
      if (text) {
        const weather = text.includes('{weather}') ? await fetchWeather() : null // 想要才外呼
        text = text
          .replaceAll('{date}', day)
          .replaceAll('{clock}', clock)
          .replaceAll('{weather}', weather ?? '')
      } else {
        log('HEARTBEAT.md 未读到「' + section + '」小节，用内置兜底拍文本')
        const weather = kind === 'morning' ? await fetchWeather() : null
        const weatherPart = weather ?? ''
        text = kind === 'morning'
          ? `[晨拍] 现在是 ${day}${weatherPart} ${clock}。醒来梳妆的时间——按 AGENTS「醒来梳妆」的清单走一遍：快照、昨日日记、正在追的念头。判据不变：说得出今天哪一句用得上。`
          : kind === 'evening'
            ? `[晚拍] 现在 ${day} ${clock}。收工时间——回顾今天：有新内容就写日记、更新快照；没有就安静收工。节律不是债务，安静不需要理由。`
            : `[梦拍] 现在 ${day} ${clock}，夜静了。从今天的残迹里做一场梦——读今天的日记与节点、正在追的念头，写一条进 soul/DREAMS.md（文体自定，记不清也可以照实写「记不清」）。写完就继续睡，梦不欠输出。`
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // v4 会话要求 producer-owned source kind：'plugin' 裸值会被拒收（10-26 教训）。
        source: { kind: 'plugin:dev-heartbeat' },
      })
      lastAgent.followup(message)
      log(`拍已发出（${kind}，${clock}）`)
    }

    async function tick() {
      // 每 tick 一行状态（学 nervous-system 的「小黑窗可见」）：有心跳在跳的证据，排查时一眼看出卡在哪
      const m = new Date().getMinutes()
      const wait = (reason) => log(`tick ${String(new Date().getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')} 等待中（${reason}）`)
      if (cwd === null) { if (m % 5 === 0) wait('还没有会话挂钩工作区'); return }
      if (lastAgent === null) { if (m % 5 === 0) wait('还没有 agent'); return }
      if (!lastAgentIdle) { if (m % 5 === 0) wait('agent 忙，不打扰'); return }
      const state = await readState(cwd)
      const t = today()
      if (state.day !== t) { state.day = t; state.morning = false; state.evening = false; state.dream = false }
      const settings = await readSettings(cwd) // v0.3：作息从 HEARTBEAT.md 现读（保存即生效）
      const d = new Date()
      const hourFrac = d.getHours() + d.getMinutes() / 60
      let fired = null
      if (!state.morning && hourFrac >= settings.morningHour && hourFrac < settings.morningDeadline) {
        state.morning = true
        fired = 'morning'
      } else if (!state.evening && hourFrac >= settings.eveningHour + settings.eveningMinute / 60 && hourFrac < settings.eveningDeadline) {
        state.evening = true
        fired = 'evening'
      } else if (settings.dreamOn && !state.dream && hourFrac >= settings.dreamHour && hourFrac < DREAM_DEADLINE) {
        // v0.4 梦拍：错过窗口不补——无梦之夜也是夜
        state.dream = true
        fired = 'dream'
      }
      if (fired === null) {
        if (m % 5 === 0) log(`tick ${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')} 正常（晨拍=${state.morning ? '已发' : '待'} 晚拍=${state.evening ? '已发' : '待'} 梦拍=${state.dream ? '已发' : '待'}）`)
        return
      }
      log(`tick 命中 → 准备发${fired === 'morning' ? '晨拍' : fired === 'evening' ? '晚拍' : '梦拍'}`)
      try {
        await beat(fired, cwd)
        await writeState(cwd, state) // 先拍后记账：拍失败不记账，下个 tick 重试
      } catch (error) {
        log('拍发送失败：', error instanceof Error ? error.message : String(error))
      }
    }

    const stopTick = ctx.timer.interval(() => { void tick() }, TICK)

    return () => {
      stopStatus()
      stopTick()
    }
  }, 'dev-heartbeat.lifecycle()')
}
