/**
 * 计算机社交流论坛 · 服务端
 * 部署在阿里云服务器上，数据存 MySQL；默认监听全部网卡，仅放行内网/校园网私有网段。
 *
 * 启动:  node server.mjs
 * 可选环境变量:
 *   PORT=8210                       监听端口
 *   FORUM_HOST=0.0.0.0              监听地址；改回 127.0.0.1 则只允许本机访问
 *   FORUM_STORE=mysql               存储类型：mysql（默认）/ sqlite / json
 *   FORUM_MYSQL_HOST=127.0.0.1      MySQL 地址（阿里云 RDS 填内网地址）
 *   FORUM_MYSQL_PORT=3306           MySQL 端口
 *   FORUM_MYSQL_USER=forum          MySQL 账号
 *   FORUM_MYSQL_PASSWORD=****       MySQL 口令
 *   FORUM_MYSQL_DATABASE=forum      MySQL 库名
 *   FORUM_MYSQL_TABLE_PREFIX=       表名前缀（一个库放多个论坛时用，如 club_）
 *   FORUM_MYSQL_SSL=1               连接启用 TLS（阿里云 RDS 建议开启）
 *   FORUM_MYSQL_SSL_CA=路径         CA 证书路径
 *   FORUM_ALLOW_CIDRS=10.0.0.0/8    额外放行的网段（逗号分隔；公网来源默认一律拒绝）
 *   FORUM_TRUSTED_PROXIES=          信任的反向代理地址（逗号分隔），用于取 X-Forwarded-For
 *   FORUM_ACCESS_CODE=xxxx          访问口令（内网也建议设置，?code=...）
 *   FORUM_ADMIN_USER=群主           启动时把该用户名提升为管理员
 *   FORUM_ADMIN_CODE=xxxx           注册时填此口令即成为管理员
 *   FORUM_WARN_ONLY=1               违规内容仅警告不拦截
 *   FORUM_LOG=路径                  启动信息与访问拒绝会追加写入该日志文件
 * 维护:
 *   node server.mjs --clear         清空用户、帖子与回复，保留空论坛
 *   node server.mjs --prune         仅清理自测/压力测试临时账号
 */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createStorage, readMysqlConfig, describeMysql } from './src/storage/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = process.env.FORUM_DATA_FILE || path.join(DATA_DIR, 'forum.json')
const DB_FILE = process.env.FORUM_DB_FILE || path.join(DATA_DIR, 'forum.db')

const PORT = Number(process.env.PORT || 8210)
const HOST = process.env.FORUM_HOST || '0.0.0.0'
const ACCESS_CODE = process.env.FORUM_ACCESS_CODE || ''
const ADMIN_USER = process.env.FORUM_ADMIN_USER || ''
const ADMIN_CODE = process.env.FORUM_ADMIN_CODE || ''
const WARN_ONLY = process.env.FORUM_WARN_ONLY === '1'
// 默认使用 MySQL（阿里云正式环境）；本地调试可设 FORUM_STORE=json
const STORE_KIND = (process.env.FORUM_STORE || 'mysql').toLowerCase()
const SESSION_TTL_MS = Number(process.env.FORUM_SESSION_TTL_MS || 30 * 24 * 3600 * 1000) // 默认 30 天
const AUTH_MAX_FAILS = Number(process.env.FORUM_AUTH_MAX_FAILS || 6) // 同 IP 连续失败次数上限
const AUTH_WINDOW_MS = Number(process.env.FORUM_AUTH_WINDOW_MS || 10 * 60 * 1000) // 失败计数窗口
const EXTRA_CIDRS = (process.env.FORUM_ALLOW_CIDRS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TRUSTED_PROXIES = (process.env.FORUM_TRUSTED_PROXIES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const MAX_USERS = 200 // 有效账号上限

const BOARDS = [
  { id: 'study', name: '学习资料区', desc: '上传/分享课件、笔记、文档、学习资源' },
  { id: 'chat', name: '闲聊交流区', desc: '群友日常聊天、讨论' },
  { id: 'qa', name: '问答求助区', desc: '提问、答疑交流' },
]

/* ------------------------------ 数据层 ------------------------------ */

let db = { users: [], posts: [], seq: { user: 0, post: 0, reply: 0 } }
let storage = null
let storageInfo = null // mysql 时的连接描述，供横幅与 /healthz 展示

/** 建立存储（mysql 需要连库建表，所以必须 await；连不上直接抛出，由 start() 报错退出） */
async function initStorage() {
  storage = await createStorage({
    kind: STORE_KIND,
    jsonFile: DATA_FILE,
    dbFile: DB_FILE,
    legacyJsonFile: path.join(DATA_DIR, 'forum.json'),
    log: (m) => {
      console.log(m)
      logLine(m)
    },
  })
  if (STORE_KIND === 'mysql') {
    storageInfo = typeof storage.info === 'function' ? storage.info() : null
  }
  return storage
}

async function load() {
  db = await storage.load()
  // 会话从存储恢复：进程/服务器重启后大家不用重新登录
  const loader = storage.loadSessions
  if (typeof loader === 'function') {
    const restored = await loader.call(storage)
    sessions.clear()
    for (const [token, s] of restored) sessions.set(token, s)
  }
}

/** 写入存储：json 实现内部做防抖，sqlite / mysql 实现原子事务写入 */
async function save() {
  try {
    await storage.persist(db)
  } catch (err) {
    console.error('[forum] 数据写入失败:', err.message)
    logLine(`[forum] 数据写入失败: ${err.message}`)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function fmtTime(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ------------------------------ 内容审核 ------------------------------ */

const RULES = [
  { name: '外部链接', re: /(https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(com|cn|net|org|io|top|xyz|vip|cc)\b)/i, tip: '禁止外部链接与引流' },
  { name: '联系方式', re: /(加我微信|微信号|加微信|vx[:：]|v信|扣扣|qq群|扫码进群|私聊我|站外|拉你进群)/i, tip: '禁止留联系方式或站外引流' },
  { name: '广告推广', re: /(广告|代理|兼职刷单|推广|带货|下单|优惠券|点击购买|代购|引流|返利|招商|推广位)/, tip: '禁止广告推广' },
  { name: '违规内容', re: /(赌博|博彩|彩票|色情|裸聊|约炮|枪支|毒品|代考|办证|贷款|套现|洗钱|诈骗|传销)/, tip: '禁止违法违规内容' },
]

function screen(text) {
  const hits = RULES.filter((r) => r.re.test(text)).map((r) => r.name)
  return { ok: hits.length === 0, hits }
}

/* ------------------------------ 会话层 ------------------------------ */

const sessions = new Map() // token -> { username }

function newToken() {
  return crypto.randomBytes(18).toString('hex')
}

/** 建立会话：内存 + 存储双写（重启后不掉线） */
async function openSession(username) {
  const token = newToken()
  sessions.set(token, { username })
  if (typeof storage.saveSession === 'function') {
    try {
      await storage.saveSession(token, username, SESSION_TTL_MS)
    } catch (err) {
      console.error('[forum] 会话写入失败:', err.message)
    }
  }
  return token
}

/** 销毁会话（退出登录、清空数据） */
async function closeSession(token) {
  sessions.delete(token)
  if (typeof storage.dropSession === 'function') {
    try {
      await storage.dropSession(token)
    } catch {
      /* 忽略 */
    }
  }
}

function currentUser(req) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const s = token ? sessions.get(token) : null
  if (!s) return null
  const u = db.users.find((x) => x.username === s.username)
  if (!u || u.banned) return null
  return u
}

/* ------------------------------ 口令与登录限流 ------------------------------ */

const scrypt = (password, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)))
  })

/** 生成 scrypt$salt$hash 形式的口令摘要 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = await scrypt(String(password), salt)
  return `scrypt$${salt}$${key.toString('hex')}`
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false
  const [, salt, hex] = stored.split('$')
  if (!salt || !hex) return false
  const key = await scrypt(String(password), salt)
  const expected = Buffer.from(hex, 'hex')
  if (expected.length !== key.length) return false
  return crypto.timingSafeEqual(key, expected)
}

// 登录/注册失败计数：同 IP 短时间内失败过多则暂时锁定，抵御口令爆破
const authFails = new Map() // ip -> { count, first, until }

function authLocked(ip) {
  const rec = authFails.get(ip)
  if (!rec) return 0
  if (rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000)
  return 0
}

function noteAuthFail(ip) {
  const now = Date.now()
  let rec = authFails.get(ip)
  if (!rec || now - rec.first > AUTH_WINDOW_MS) rec = { count: 0, first: now, until: 0 }
  rec.count += 1
  if (rec.count >= AUTH_MAX_FAILS) {
    rec.until = now + AUTH_WINDOW_MS
    rec.count = 0
    rec.first = now
    logLine(`[forum] 来源 ${ip} 口令失败次数过多，已锁定 ${Math.round(AUTH_WINDOW_MS / 60000)} 分钟`)
  }
  authFails.set(ip, rec)
}

function clearAuthFail(ip) {
  authFails.delete(ip)
}

/* 定期清理过期会话与限流记录 */
function startHousekeeping() {
  const timer = setInterval(() => {
    if (typeof storage.pruneSessions === 'function') {
      Promise.resolve()
        .then(() => storage.pruneSessions())
        .catch(() => {
          /* 忽略 */
        })
    }
    const now = Date.now()
    for (const [ip, rec] of authFails) {
      if (now - rec.first > AUTH_WINDOW_MS && (!rec.until || rec.until < now)) authFails.delete(ip)
    }
  }, 10 * 60 * 1000)
  timer.unref?.()
  return timer
}

/* ------------------------------ 访问控制（校园网） ------------------------------ */

// 默认放行：回环 + 校园网/局域网私有网段 + 链路本地
const DEFAULT_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]
const ALLOW_CIDRS = DEFAULT_CIDRS.concat(EXTRA_CIDRS)

const denyLog = [] // 最近被拒绝的来源，便于把校园网网段补进白名单

function normalizeIp(raw) {
  let ip = String(raw || '').trim()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  return ip
}

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n * 256) + v
  }
  return n
}

function ipv6ToBytes(ip) {
  let s = ip
  const pct = s.indexOf('%')
  if (pct >= 0) s = s.slice(0, pct)
  const zoneSplit = s.split('::')
  if (zoneSplit.length > 2) return null
  const head = zoneSplit[0] ? zoneSplit[0].split(':') : []
  const tail = zoneSplit.length === 2 && zoneSplit[1] ? zoneSplit[1].split(':') : []
  const fills = 8 - head.length - tail.length
  if (fills < 0) return null
  const groups = zoneSplit.length === 2 ? head.concat(new Array(fills).fill('0'), tail) : head
  if (groups.length !== 8) return null
  const bytes = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push((v >> 8) & 255, v & 255)
  }
  return bytes
}

export function inAnyCidr(ip, cidrs) {
  const raw = normalizeIp(ip)
  const mapped = ipv4ToInt(raw)
  const v4 = mapped !== null ? mapped : ipv4ToInt(raw.replace(/^::ffff:/, ''))
  const v6 = v4 === null ? ipv6ToBytes(raw) : null
  for (const entry of cidrs) {
    const [netRaw, bitsRaw] = entry.split('/')
    const net = normalizeIp(netRaw)
    const bits = Number(bitsRaw)
    if (v4 !== null) {
      const netInt = ipv4ToInt(net)
      if (netInt === null) continue
      const b = Number.isFinite(bits) ? bits : 32
      if (b < 0 || b > 32) continue
      const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0
      if (((v4 & mask) >>> 0) === ((netInt & mask) >>> 0)) return true
    } else if (v6 !== null) {
      const netBytes = ipv6ToBytes(net)
      if (netBytes === null) continue
      const b = Number.isFinite(bits) ? bits : 128
      if (b < 0 || b > 128) continue
      let ok = true
      for (let i = 0; i < 16 && ok; i++) {
        const rem = b - i * 8
        if (rem <= 0) break
        const m = rem >= 8 ? 255 : (0xff << (8 - rem)) & 0xff
        if ((v6[i] & m) !== (netBytes[i] & m)) ok = false
      }
      if (ok) return true
    }
  }
  return false
}

/** 取真实来源地址；仅当直连方是受信代理时才采信 X-Forwarded-For */
function clientIp(req) {
  const direct = normalizeIp(req.socket.remoteAddress)
  if (TRUSTED_PROXIES.length && TRUSTED_PROXIES.indexOf(direct) >= 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xff) return normalizeIp(xff)
  }
  return direct
}

function noteDenied(ip, why, pathname) {
  denyLog.unshift({ at: fmtTime(nowIso()), ip, why, path: pathname })
  if (denyLog.length > 20) denyLog.pop()
  const text = `[forum] 已拒绝 ${ip} → ${pathname}（${why}）`
  console.log(text)
  logLine(text)
}

/** 仅当监听全部网卡时才做来源校验；只监听回环时本就只有本机能连 */
function denyExternal(req) {
  if (HOST !== '0.0.0.0' && HOST !== '::') return null
  const ip = clientIp(req)
  if (!inAnyCidr(ip, ALLOW_CIDRS)) {
    noteDenied(ip, '不在校园网白名单内', req.url)
    return '仅限校园网/内网访问，已拒绝外部请求。'
  }
  if (ACCESS_CODE) {
    const url = new URL(req.url, 'http://local')
    const code = url.searchParams.get('code') || req.headers['x-forum-code'] || ''
    if (code !== ACCESS_CODE) {
      noteDenied(ip, '未携带正确访问口令', req.url)
      return '缺少或错误的访问口令（?code=...），仅限本群/校园网内部访问。'
    }
  }
  return null
}

/* ------------------------------ 工具 ------------------------------ */

const BOARD_ALIAS = new Map()
for (const b of BOARDS) {
  BOARD_ALIAS.set(b.id, b)
  BOARD_ALIAS.set(b.name, b)
}
BOARD_ALIAS.set('学习', BOARD_ALIAS.get('学习资料区'))
BOARD_ALIAS.set('资料', BOARD_ALIAS.get('学习资料区'))
BOARD_ALIAS.set('闲聊', BOARD_ALIAS.get('闲聊交流区'))
BOARD_ALIAS.set('聊天', BOARD_ALIAS.get('闲聊交流区'))
BOARD_ALIAS.set('问答', BOARD_ALIAS.get('问答求助区'))
BOARD_ALIAS.set('求助', BOARD_ALIAS.get('问答求助区'))

function findBoard(v) {
  if (!v) return null
  const key = String(v).trim().replace(/^【|】$/g, '')
  return BOARD_ALIAS.get(key) || null
}

function findPost(id) {
  const n = Number(String(id).replace(/[^0-9]/g, ''))
  return db.posts.find((p) => p.id === n) || null
}

function postView(p, withReplies = true) {
  const board = BOARDS.find((b) => b.id === p.board)
  return {
    id: p.id,
    board: p.board,
    boardName: board ? board.name : p.board,
    author: p.author,
    createdAt: p.createdAt,
    createdAtText: fmtTime(p.createdAt),
    title: p.title,
    content: p.content,
    images: p.images || [],
    kind: p.kind || 'text',
    pinned: !!p.pinned,
    replyCount: p.replies.length,
    floorCount: p.replies.length + 1,
    replies: withReplies
      ? p.replies.map((r) => ({
          floor: r.floor,
          author: r.author,
          createdAt: r.createdAt,
          createdAtText: fmtTime(r.createdAt),
          content: r.content,
          images: r.images || [],
          replyTo: r.replyTo ?? null,
        }))
      : [],
  }
}

function memberSummary() {
  const valid = db.users.filter((u) => !u.banned)
  return { used: valid.length, max: MAX_USERS, left: Math.max(0, MAX_USERS - valid.length) }
}

/* ------------------------------ 指令解析 ------------------------------ */

/** 支持中文全角/半角冒号、逗号、空格混写 */
function parseCommand(raw) {
  const text = String(raw || '').trim()
  if (!text) return { cmd: 'help' }
  const head = text.split(/[\s:：]/, 1)[0]
  const rest = text.slice(head.length).replace(/^[\s:：]+/, '')

  if (/^(注册|register|登记)$/i.test(head)) {
    // 支持 注册：用户名xxx  /  注册：用户名xxx，密码=yyy  /  注册：用户名xxx，密码=yyy，口令=管理员口令
    const pairs = parsePairs(rest, '用户名')
    const name = (pairs['用户名'] || pairs.content || '').replace(/^用户名/, '').replace(/^[:：=]/, '').trim()
    const code = pairs['口令'] || pairs['管理员口令'] || pairs['adminCode'] || ''
    const password = pairs['密码'] || pairs['password'] || ''
    return { cmd: 'register', username: name, adminCode: code, password, raw: text }
  }
  if (/^(登录|login)$/i.test(head)) {
    const pairs = parsePairs(rest, '用户名')
    const name = (pairs['用户名'] || pairs.content || '').replace(/^用户名/, '').replace(/^[:：=]/, '').trim()
    const password = pairs['密码'] || pairs['password'] || ''
    return { cmd: 'login', username: name, password, raw: text }
  }
  if (/^(退出|logout)$/i.test(head)) return { cmd: 'logout' }
  if (/^(发帖|发布|post)$/i.test(head)) return { cmd: 'post', args: parsePairs(rest) }
  if (/^(查看全部帖子|全部帖子|列表|list)$/i.test(head) || /^查看全部帖子$/.test(text)) return { cmd: 'listAll' }
  if (/^(查看板块|板块)$/i.test(head)) return { cmd: 'listBoard', board: rest.replace(/^【|】$/g, '').trim() }
  if (/^(查看帖子|帖子)$/i.test(head)) return { cmd: 'viewPost', id: rest }
  if (/^(回复帖子|回复)$/i.test(head)) return { cmd: 'reply', args: parsePairs(rest) }
  if (/^(删除帖子|删帖)$/i.test(head)) return { cmd: 'delPost', id: rest }
  if (/^(置顶)$/i.test(head)) return { cmd: 'pin', id: rest }
  if (/^(封禁用户|封禁)$/i.test(head)) return { cmd: 'ban', username: rest }
  if (/^(清空全部数据|清空论坛|重置论坛)$/i.test(head)) return { cmd: 'clearAll' }

  // 宽松兜底
  if (/^查看全部帖子/.test(text)) return { cmd: 'listAll' }
  const mBoard = text.match(/^查看板块\s*[:：]?\s*【?([^】]+)】?/)
  if (mBoard) return { cmd: 'listBoard', board: mBoard[1].trim() }
  const mView = text.match(/^查看帖子\s*ID\s*[:：]?\s*(\d+)/i)
  if (mView) return { cmd: 'viewPost', id: mView[1] }
  const mRep = text.match(/^回复帖子\s*ID\s*[:：]?\s*(\d+)\s*[,，]?\s*(?:内容\s*[:：=]\s*)?([\s\S]+)$/i)
  if (mRep) return { cmd: 'reply', args: { id: mRep[1], content: mRep[2] } }
  const mPost = text.match(/^发帖\s*[:：]?\s*([\s\S]+)$/)
  if (mPost) return { cmd: 'post', args: parsePairs(mPost[1]) }
  return { cmd: 'unknown', raw: text }
}

/**
 * 解析 "板块=学习资料区，内容=xxx，标题=yyy" 形式的键值对。
 * 规则：先按中英文逗号切分；含 "=" 的片段视作新的键值对，
 * 不含 "=" 的片段并入上一个键的值，从而允许内容中出现逗号。
 * bare 指定无键片段默认归属的字段（发帖/回复为 content，注册为 用户名）。
 */
function parsePairs(s, bare) {
  const out = {}
  let lastKey = null
  const defaultKey = bare || 'content'
  const segments = String(s || '').split(/[，,]/)
  for (const segRaw of segments) {
    const seg = segRaw.trim()
    if (!seg) continue
    const eq = seg.indexOf('=')
    if (eq > 0) {
      const key = seg.slice(0, eq).trim()
      const val = seg.slice(eq + 1).trim()
      out[key] = out[key] === undefined ? val : `${out[key]} ${val}`
      lastKey = key
    } else if (lastKey) {
      out[lastKey] = `${out[lastKey]} ${seg}`.trim()
    } else {
      const colon = seg.search(/[:：]/)
      if (colon > 0) {
        const key = seg.slice(0, colon).trim()
        out[key] = seg.slice(colon + 1).trim()
        lastKey = key
      } else {
        out[defaultKey] = out[defaultKey] === undefined ? seg : `${out[defaultKey]} ${seg}`
        lastKey = defaultKey
      }
    }
  }
  return out
}

function pick(args, names) {
  for (const n of names) if (args[n] !== undefined) return args[n]
  return undefined
}

/* ------------------------------ 业务动作 ------------------------------ */

async function doRegister(username, adminCode, password) {
  const name = String(username || '').trim()
  if (!name) return { ok: false, message: '请输入用户名。示例：注册：用户名你的昵称，密码=你的密码' }
  if (name.length > 16) return { ok: false, message: '用户名最多 16 个字符。' }
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_\-]+$/.test(name)) return { ok: false, message: '用户名只能包含中文、字母、数字、下划线或短横线。' }
  if (db.users.some((u) => u.username === name)) return { ok: false, message: `用户名「${name}」已存在，请换一个。` }
  const pwd = String(password || '')
  if (pwd && pwd.length < 6) return { ok: false, message: '密码至少 6 位。示例：注册：用户名你的昵称，密码=abc12345' }
  const active = db.users.filter((u) => !u.banned).length
  if (active >= MAX_USERS) return { ok: false, message: `计算机社交流论坛账号已达上限 ${MAX_USERS} 人，无法再注册。` }
  const isAdmin = !!adminCode && !!ADMIN_CODE && adminCode === ADMIN_CODE
  const user = {
    id: ++db.seq.user,
    username: name,
    role: isAdmin ? 'admin' : 'member',
    createdAt: nowIso(),
    banned: false,
    passwordHash: pwd ? await hashPassword(pwd) : null,
  }
  db.users.push(user)
  if (ADMIN_USER && ADMIN_USER === name) user.role = 'admin'
  await save()
  const token = await openSession(name)
  return {
    ok: true,
    token,
    user: publicUser(user),
    message: `注册成功，欢迎「${name}」加入（${isAdmin ? '管理员' : '普通成员'}）。${pwd ? '' : '建议设置密码：注册时加「密码=xxx」，避免昵称被他人冒用。'}`,
  }
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, createdAtText: fmtTime(u.createdAt), hasPassword: !!u.passwordHash }
}

/**
 * 登录校验：
 *  - 已设置密码的账号必须提供正确密码；
 *  - 早期无密码账号，首次登录可用纯昵称，此时若带了密码就直接写入（平滑升级）。
 */
async function doLogin(username, password) {
  const name = String(username || '').trim()
  const u = db.users.find((x) => x.username === name)
  if (!u) return { ok: false, message: `用户「${name}」不存在，请先注册：注册：用户名${name}，密码=你的密码` }
  if (u.banned) return { ok: false, message: `用户「${name}」已被封禁。` }
  const pwd = String(password || '')

  if (u.passwordHash) {
    if (!pwd) return { ok: false, message: '该账号已设置密码，请输入：登录：用户名xxx，密码=你的密码', needPassword: true }
    if (!(await verifyPassword(pwd, u.passwordHash))) return { ok: false, message: '密码不正确。', needPassword: true }
  } else if (pwd) {
    if (pwd.length < 6) return { ok: false, message: '密码至少 6 位。' }
    u.passwordHash = await hashPassword(pwd)
    await save()
  }

  const token = await openSession(name)
  return { ok: true, token, user: publicUser(u), message: `「${name}」已登录。${u.passwordHash ? '' : '提醒：该账号尚未设置密码，建议尽快设置。'}` }
}

async function doPost(user, args) {
  if (!user) return { ok: false, message: '请先注册或登录后再发帖。示例：注册：用户名你的昵称' }
  const board = findBoard(pick(args, ['板块', 'board', '分区']))
  if (!board) {
    return { ok: false, message: `板块不存在，只能选择：${BOARDS.map((b) => `【${b.name}】`).join(' ')}。示例：发帖：板块=学习资料区，内容=高数第三章笔记` }
  }
  let content = pick(args, ['内容', 'content', '正文', 'text']) || args.extra || ''
  content = String(content).trim()
  if (!content) return { ok: false, message: '内容不能为空。示例：发帖：板块=闲聊交流区，内容=大家好' }
  if (content.length > 4000) return { ok: false, message: '单条内容最多 4000 字。' }

  const images = []
  const cleaned = content.replace(/【图片\s*[:：]\s*([^】]*)】/g, (_, desc) => {
    images.push(String(desc).trim() || '未命名图片')
    return ''
  }).trim()

  const body = (cleaned + ' ' + images.join(' ')).trim()
  const screened = screen(body)
  if (!screened.ok && !WARN_ONLY) {
    return { ok: false, message: `发布被拦截：包含${screened.hits.join('、')}。计算机社交流论坛禁止违规、广告、外部引流内容。` }
  }

  const post = {
    id: ++db.seq.post,
    board: board.id,
    author: user.username,
    createdAt: nowIso(),
    title: String(pick(args, ['标题', 'title']) || '').trim() || (cleaned ? cleaned.slice(0, 24) : (images[0] ? `【图片：${images[0]}】` : '无标题')),
    content: cleaned,
    images,
    kind: images.length ? (cleaned ? 'mixed' : 'image') : 'text',
    pinned: false,
    replies: [],
  }
  db.posts.push(post)
  await save()
  return {
    ok: true,
    post: postView(post, false),
    warn: screened.ok ? null : `注意：内容包含${screened.hits.join('、')}，已放行但请遵守群规。`,
    message: `发布成功，帖子 ID:${post.id}（${board.name}）。`,
  }
}

async function doReply(user, args) {
  if (!user) return { ok: false, message: '请先注册或登录后再回复。' }
  const idRaw = pick(args, ['id', 'ID', '帖子', '帖子ID'])
  const post = findPost(idRaw)
  if (!post) return { ok: false, message: `帖子 ID:${String(idRaw || '').replace(/[^0-9]/g, '') || '?'} 不存在。可先「查看全部帖子」。` }
  let content = pick(args, ['内容', 'content', '正文']) || args.extra || ''
  content = String(content).trim()
  if (!content) return { ok: false, message: '回复内容不能为空。示例：回复帖子ID:1，内容=收到，谢谢分享' }

  const images = []
  const cleaned = content.replace(/【图片\s*[:：]\s*([^】]*)】/g, (_, desc) => {
    images.push(String(desc).trim() || '未命名图片')
    return ''
  }).trim()
  const screened = screen((cleaned + ' ' + images.join(' ')).trim())
  if (!screened.ok && !WARN_ONLY) {
    return { ok: false, message: `回复被拦截：包含${screened.hits.join('、')}。计算机社交流论坛禁止违规、广告、外部引流内容。` }
  }

  const floor = post.replies.length + 2 // 楼主是 1 楼
  const reply = {
    floor,
    author: user.username,
    createdAt: nowIso(),
    content: cleaned,
    images,
    replyTo: post.replies.length ? post.replies[post.replies.length - 1].floor : null,
  }
  post.replies.push(reply)
  await save()
  return { ok: true, reply: { ...reply, createdAtText: fmtTime(reply.createdAt) }, postId: post.id, message: `回复成功，${floor} 楼。` }
}

/* ------------------------------ 路由 ------------------------------ */

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

async function handleApi(req, res, url) {
  const pathname = url.pathname
  const user = currentUser(req)

  // 健康检查：负载均衡/监控用，不校验来源网段的白名单之外仍受安全组保护
  if (pathname === '/healthz' && req.method === 'GET') {
    const body = {
      ok: true,
      store: storage.kind,
      members: memberSummary().used,
      posts: db.posts.length,
      sessions: typeof storage.sessionCount === 'function' ? storage.sessionCount() : sessions.size,
      uptimeSec: Math.round(process.uptime()),
    }
    if (storageInfo) {
      // 顺带探活数据库：RDS 挂了 /healthz 立刻能看出来
      Object.assign(body, {
        db: storageInfo.server,
        dbUser: storageInfo.user,
        dbVersion: storageInfo.version,
      })
      try {
        body.dbVersion = await storage.ping()
        body.dbOk = true
      } catch (err) {
        body.ok = false
        body.dbOk = false
        body.dbError = err && err.message ? err.message : String(err)
      }
    }
    return json(res, body.ok ? 200 : 503, body)
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const board = url.searchParams.get('board')
    const keyword = (url.searchParams.get('q') || '').trim()
    let posts = db.posts.slice()
    if (board && board !== 'all') posts = posts.filter((p) => p.board === board)
    if (keyword) {
      posts = posts.filter((p) => p.content.includes(keyword) || p.title.includes(keyword) || p.author.includes(keyword))
    }
    posts.sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
    return json(res, 200, {
      ok: true,
      boards: BOARDS,
      posts: posts.map((p) => postView(p, false)),
      members: memberSummary(),
      users: db.users.map(publicUser),
      me: user ? publicUser(user) : null,
      serverTime: fmtTime(nowIso()),
      keywords: keyword,
    })
  }

  if (pathname === '/api/post' && req.method === 'GET') {
    const post = findPost(url.searchParams.get('id'))
    if (!post) return json(res, 404, { ok: false, message: '帖子不存在' })
    return json(res, 200, { ok: true, post: postView(post, true) })
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await readBody(req)
    const ip = clientIp(req)
    const lock = authLocked(ip)
    if (lock) return json(res, 429, { ok: false, message: `尝试过于频繁，请 ${Math.ceil(lock / 60)} 分钟后再试。` })
    const r = await doRegister(body.username, body.adminCode, body.password)
    if (!r.ok) noteAuthFail(ip)
    else clearAuthFail(ip)
    return json(res, 200, r)
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req)
    const ip = clientIp(req)
    const lock = authLocked(ip)
    if (lock) return json(res, 429, { ok: false, message: `口令尝试失败次数过多，请 ${Math.ceil(lock / 60)} 分钟后再试。` })
    const r = await doLogin(body.username, body.password)
    if (!r.ok) noteAuthFail(ip)
    else clearAuthFail(ip)
    return json(res, 200, r)
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const auth = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) await closeSession(token)
    return json(res, 200, { ok: true, message: '已退出登录。' })
  }

  if (pathname === '/api/post' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, await doPost(user, {
      板块: body.board,
      内容: body.content,
      标题: body.title,
    }))
  }

  if (pathname === '/api/reply' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, await doReply(user, { id: body.id, 内容: body.content }))
  }

  if (pathname === '/api/command' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, await runCommand(body.text, user, clientIp(req)))
  }

  if (pathname === '/api/admin' && req.method === 'POST') {
    const body = await readBody(req)
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: '仅管理员可执行该操作。' })
    const action = body.action
    if (action === 'delete') {
      const idx = db.posts.findIndex((p) => p.id === Number(body.id))
      if (idx < 0) return json(res, 404, { ok: false, message: '帖子不存在' })
      db.posts.splice(idx, 1)
      await save()
      return json(res, 200, { ok: true, message: `已删除帖子 ID:${body.id}` })
    }
    if (action === 'pin') {
      const p = findPost(body.id)
      if (!p) return json(res, 404, { ok: false, message: '帖子不存在' })
      p.pinned = !p.pinned
      await save()
      return json(res, 200, { ok: true, message: `${p.pinned ? '已置顶' : '已取消置顶'} ID:${p.id}`, pinned: p.pinned })
    }
    if (action === 'ban') {
      const u = db.users.find((x) => x.username === body.username)
      if (!u) return json(res, 404, { ok: false, message: '用户不存在' })
      u.banned = !u.banned
      await save()
      return json(res, 200, { ok: true, message: `${u.banned ? '已封禁' : '已解封'}用户 ${u.username}` })
    }
    return json(res, 400, { ok: false, message: '未知管理操作' })
  }

  if (pathname === '/api/access' && req.method === 'GET') {
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: '仅管理员可查看访问诊断。' })
    return json(res, 200, {
      ok: true,
      bind: HOST,
      port: PORT,
      store: storage.kind,
      storeWhere: storageInfo ? storageInfo.server : storage.describe(),
      tablePrefix: storageInfo ? storageInfo.tablePrefix : '',
      allowCidrs: ALLOW_CIDRS,
      extraCidrs: EXTRA_CIDRS,
      accessCode: ACCESS_CODE ? '已启用' : '未设置',
      trustedProxies: TRUSTED_PROXIES,
      denied: denyLog,
    })
  }

  return json(res, 404, { ok: false, message: '接口不存在' })
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname
  rel = path.normalize(rel).replace(/^([/\\])+/, '')
  const file = path.join(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('404 not found')
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(buf)
  })
}

/* ------------------------------ 服务实例（可选 HTTPS） ------------------------------ */

const TLS_CERT = process.env.FORUM_TLS_CERT || ''
const TLS_KEY = process.env.FORUM_TLS_KEY || ''
const TLS_ENABLED = !!(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY))

const server = TLS_ENABLED
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler)

async function handler(req, res) {
  const denied = denyExternal(req)
  if (denied) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(denied)
  }
  const url = new URL(req.url, 'http://local')
  try {
    if (url.pathname === '/healthz') return await handleApi(req, res, url)
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    return serveStatic(req, res, url)
  } catch (err) {
    console.error('[forum] 请求异常:', err)
    if (!res.headersSent) json(res, 500, { ok: false, message: '服务器内部错误' })
  }
}

// 供自测脚本启动/关闭临时实例，并在退出前强制落盘
export { server }

/** 立即把内存数据写入存储（跳过防抖），用于关闭前或自测清理。 */
export async function flush() {
  if (!storage) return
  try {
    await storage.flush(db)
  } catch (err) {
    console.error('[forum] 数据写入失败:', err.message)
  }
}

/** 关闭存储连接（自测脚本用完临时实例后调用，避免连接池挂住进程） */
export async function closeStorage() {
  if (!storage) return
  try {
    await storage.close()
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 指令执行（同时给网页与命令行用） ------------------------------ */

async function runCommand(rawText, user, ip) {
  const parsed = parseCommand(rawText)
  const lines = []
  const lockSec = ip ? authLocked(ip) : 0
  if (lockSec && (parsed.cmd === 'register' || parsed.cmd === 'login')) {
    return { ok: false, command: rawText, text: textOut('已锁定', [`口令尝试失败次数过多，请 ${Math.ceil(lockSec / 60)} 分钟后再试。`]) }
  }
  switch (parsed.cmd) {
    case 'register': {
      const r = await doRegister(parsed.username, parsed.adminCode, parsed.password)
      if (!r.ok && ip) noteAuthFail(ip)
      if (r.ok && ip) clearAuthFail(ip)
      return { ok: r.ok, command: rawText, text: textOut(r.ok ? '注册成功' : '注册失败', [r.message], r.ok ? [['用户名', r.user.username], ['身份', r.user.role === 'admin' ? '管理员' : '普通成员'], ['当前人数', `${memberSummary().used}/${MAX_USERS}`]] : []), token: r.token, user: r.user }
    }
    case 'login': {
      const r = await doLogin(parsed.username, parsed.password)
      if (!r.ok && ip) noteAuthFail(ip)
      if (r.ok && ip) clearAuthFail(ip)
      return { ok: r.ok, command: rawText, text: textOut(r.ok ? '登录成功' : '登录失败', [r.message]), token: r.token, user: r.user }
    }
    case 'logout':
      return { ok: true, command: rawText, text: textOut('已退出', ['当前设备已退出登录。']), token: null, user: null }
    case 'post': {
      const r = await doPost(user, parsed.args)
      const lines2 = [r.message].concat(r.warn ? [r.warn] : [])
      return { ok: r.ok, command: rawText, text: textOut(r.ok ? '发帖结果' : '发帖失败', lines2, r.ok ? [['帖子ID', r.post.id], ['板块', r.post.boardName], ['发布人', r.post.author], ['时间', r.post.createdAtText]] : []), post: r.post }
    }
    case 'reply': {
      const r = await doReply(user, parsed.args)
      return { ok: r.ok, command: rawText, text: textOut(r.ok ? '回复结果' : '回复失败', [r.message]), postId: r.postId }
    }
    case 'listAll': {
      const posts = db.posts.slice().sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
      return { ok: true, command: rawText, text: renderPostList('全部帖子', posts, true) }
    }
    case 'listBoard': {
      const board = findBoard(parsed.board)
      if (!board) return { ok: false, command: rawText, text: `板块不存在。可选：${BOARDS.map((b) => `【${b.name}】`).join(' ')}` }
      const posts = db.posts.filter((p) => p.board === board.id).sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
      return { ok: true, command: rawText, text: renderPostList(`板块【${board.name}】`, posts, false) }
    }
    case 'viewPost': {
      const post = findPost(parsed.id)
      if (!post) return { ok: false, command: rawText, text: `帖子 ID:${String(parsed.id).replace(/[^0-9]/g, '')} 不存在。` }
      return { ok: true, command: rawText, text: renderThread(post) }
    }
    case 'delPost': {
      if (!user || user.role !== 'admin') return { ok: false, command: rawText, text: '仅管理员可删帖。' }
      const idx = db.posts.findIndex((p) => p.id === Number(String(parsed.id).replace(/[^0-9]/g, '')))
      if (idx < 0) return { ok: false, command: rawText, text: '帖子不存在。' }
      const [removed] = db.posts.splice(idx, 1)
      await save()
      return { ok: true, command: rawText, text: `已删除帖子 ID:${removed.id}` }
    }
    case 'pin': {
      if (!user || user.role !== 'admin') return { ok: false, command: rawText, text: '仅管理员可置顶。' }
      const p = findPost(parsed.id)
      if (!p) return { ok: false, command: rawText, text: '帖子不存在。' }
      p.pinned = !p.pinned
      await save()
      return { ok: true, command: rawText, text: `${p.pinned ? '已置顶' : '已取消置顶'} ID:${p.id}` }
    }
    case 'ban': {
      if (!user || user.role !== 'admin') return { ok: false, command: rawText, text: '仅管理员可封禁。' }
      const u = db.users.find((x) => x.username === String(parsed.username).trim())
      if (!u) return { ok: false, command: rawText, text: '用户不存在。' }
      u.banned = !u.banned
      await save()
      return { ok: true, command: rawText, text: `${u.banned ? '已封禁' : '已解封'}用户 ${u.username}` }
    }
    case 'clearAll': {
      if (!user || user.role !== 'admin') return { ok: false, command: rawText, text: '仅管理员可清空论坛数据。' }
      db.users = []
      db.posts = []
      db.seq = { user: 0, post: 0, reply: 0 }
      sessions.clear()
      if (typeof storage.clearSessions === 'function') await storage.clearSessions()
      await save()
      return { ok: true, command: rawText, text: '已清空全部用户、帖子与回复，论坛恢复为空白状态（所有登录状态一并失效）。' }
    }
    default:
      return { ok: false, command: rawText, text: HELP_TEXT }
  }
}

function textOut(title, lines, fields) {
  const parts = [`【${title}】`]
  if (lines && lines.length) parts.push(...lines)
  if (fields && fields.length) parts.push(...fields.map(([k, v]) => `  ${k}：${v}`))
  return parts.join('\n')
}

function renderPostList(title, posts, showBoard) {
  const out = [`===== ${title}（共 ${posts.length} 帖 / 有效用户 ${memberSummary().used}/${MAX_USERS}） =====`]
  if (!posts.length) out.push('（暂无帖子）')
  for (const p of posts) {
    out.push(`${p.pinned ? '[置顶] ' : ''}#${p.id} [${BOARDS.find((b) => b.id === p.board).name}] ${p.author} · ${fmtTime(p.createdAt)} · 回复 ${p.replies.length}`)
    out.push(`    ${p.content ? p.content.split('\n')[0].slice(0, 60) : ''}${p.images.map((i) => `【图片：${i}】`).join('')}`.trimEnd())
    out.push(`    → 查看帖子ID:${p.id}`)
    if (showBoard) out.push('')
  }
  return out.join('\n')
}

function renderThread(p) {
  const board = BOARDS.find((b) => b.id === p.board)
  const out = [
    `===== 帖子 ID:${p.id} · 板块【${board.name}】 · 共 ${p.replies.length + 1} 楼 =====`,
    `1楼  楼主  ${p.author}   ${fmtTime(p.createdAt)}`,
    `      ${p.content || ''}`,
  ]
  for (const img of p.images) out.push(`      【图片：${img}】`)
  for (const r of p.replies) {
    out.push(`${r.floor}楼  回复  ${r.author}   ${fmtTime(r.createdAt)}${r.replyTo ? `（回复 ${r.replyTo} 楼）` : ''}`)
    out.push(`      ${r.content || ''}`)
    for (const img of r.images || []) out.push(`      【图片：${img}】`)
  }
  out.push(`----- 回复请使用：回复帖子ID:${p.id}，内容=... -----`)
  return out.join('\n')
}

const HELP_TEXT = [
  '===== 指令说明（计算机社交流论坛） =====',
  '  注册：用户名xxx，密码=你的密码   注册新成员账号（上限 200 人）',
  '  登录：用户名xxx，密码=你的密码   换设备后登录已有账号',
  '  退出                              退出当前设备的登录状态',
  '  发帖：板块=学习资料区，内容=xxx【图片：说明】',
  '                            可选板块：【学习资料区】【闲聊交流区】【问答求助区】',
  '  查看全部帖子               列出全部帖子',
  '  查看板块【闲聊交流区】     按板块筛选',
  '  查看帖子ID:1 的全部回复    查看单帖全部楼层',
  '  回复帖子ID:1，内容=xxx     跟帖回复',
  '  管理员：删除帖子ID:xx / 置顶帖子ID:xx / 封禁用户xxx / 清空全部数据',
  '  说明：同名昵称请务必设置密码，否则他人可用你的昵称登录。',
].join('\n')

/* ------------------------------ 启动 ------------------------------ */

// 被 import 时（例如自测脚本）只导出工具函数，不加载数据、不监听端口
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const selfPath = path.resolve(fileURLToPath(import.meta.url))
const IS_MAIN = entryPath !== '' && entryPath.toLowerCase() === selfPath.toLowerCase()

/** 启动实例：加载数据、处理 --clear/--seed、开始监听。自测脚本可直接调用。 */
export async function start() {
  // 先建立存储（mysql 会在这里连库并自动建表），失败就没必要继续
  await initStorage()
  await load()

  const CLEAR = process.argv.includes('--clear')

  // node server.mjs --clear 清空全部用户、帖子与回复（论坛开张前使用）
  if (CLEAR) {
    await storage.wipe(db)
    if (typeof storage.clearSessions === 'function') await storage.clearSessions()
    console.log('[forum] 已清空用户、帖子与回复，论坛为空。')
    if (!process.argv.includes('--serve')) {
      await storage.close()
      process.exit(0)
    }
  }

  // node server.mjs --prune 移除自测/压力测试留下的临时账号（按名单）
  if (process.argv.includes('--prune')) {
    const before = db.users.length
    db.users = db.users.filter((u) => !/^(测试丙|压力\d+|自测.*|临时.*)$/.test(u.username))
    await flush()
    console.log(`[forum] 已清理临时账号：用户 ${before} → ${db.users.length}（保留：${db.users.map((u) => u.username).join('、') || '无'}）`)
    if (!process.argv.includes('--serve')) {
      await storage.close()
      process.exit(0)
    }
  }

  // node server.mjs --seed 写入演示样例（需自备 seed-data.mjs，默认不使用）
  if (process.argv.includes('--seed') && fs.existsSync(path.join(__dirname, 'seed-data.mjs'))) {
    const { seed } = await import('./seed-data.mjs')
    const r = seed(db, { reset: process.argv.includes('--reset') })
    if (r.added) await save()
    console.log('[forum] 演示数据已就绪（--seed）')
  }

  // 定期清理过期会话与限流记录
  startHousekeeping()

  // 退出前落盘，避免"关服丢数据"
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[forum] 收到 ${signal}，正在保存数据并退出…`)
    try {
      await flush()
      await storage.close()
    } catch {
      /* 忽略 */
    }
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      printBanner()
      resolve(server)
    })
  })
}

function fatal(stage, err) {
  const text = `[forum] ${stage}失败: ${err && err.message ? err.message : err}`
  console.error(text)
  logLine(text)
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[forum] 端口 ${PORT} 已被占用：可能已有一个论坛服务在运行。`)
    console.error('[forum] 处理：浏览器打开 http://127.0.0.1:' + PORT + ' 确认是否可用；否则先结束占用进程再启动。')
    console.error(`[forum] 查占用： Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }`)
  }
  if (STORE_KIND === 'mysql') {
    console.error('[forum] 数据库排查：')
    console.error(`[forum]   1) MySQL 服务是否启动： Get-Service *mysql*`)
    console.error(`[forum]   2) 库是否已建：mysql -u root -p < deploy\\mysql\\01-schema.sql`)
    console.error(`[forum]   3) 连接参数：FORUM_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE（当前 ${describeMysql(safeMysqlConfig())}）`)
    console.error('[forum]   4) 驱动是否装了：npm install mysql2 --registry=https://registry.npmmirror.com')
  }
  process.exit(1)
}

/** 读取 MySQL 配置，仅用于报错提示；配置本身非法时不掩盖原始错误 */
function safeMysqlConfig() {
  try {
    return readMysqlConfig()
  } catch {
    return { host: '?', port: '?', database: '?', ssl: false }
  }
}

/* 可选文件日志：设置 FORUM_LOG=路径 后，启动与访问拒绝都会追加写入该文件 */
const LOG_FILE = process.env.FORUM_LOG || ''
function logLine(text) {
  if (!LOG_FILE) return
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch {
    /* 日志写不进去不应影响服务 */
  }
}

// 兜底：任何未捕获异常都记录并尽量保持进程存活，避免"打着打着就登不上"
process.on('uncaughtException', (err) => {
  const text = `[forum] 未捕获异常: ${err && err.stack ? err.stack : err}`
  console.error(text)
  logLine(text)
})
process.on('unhandledRejection', (reason) => {
  const text = `[forum] 未处理的 Promise 拒绝: ${reason && reason.stack ? reason.stack : reason}`
  console.error(text)
  logLine(text)
})

if (IS_MAIN) {
  start().catch((err) => fatal('启动', err))
}


function printBanner() {
  const nets = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) nets.push(n.address)
  }
  const openBind = HOST === '0.0.0.0' || HOST === '::'
  console.log('')
  console.log('  ╔══════════════════════════════════════════════════════════╗')
  console.log('  ║   计算机社交流论坛 · 最多 200 人 · 阿里云部署 · MySQL    ║')
  console.log('  ╚══════════════════════════════════════════════════════════╝')
  const scheme = TLS_ENABLED ? 'https' : 'http'
  console.log(`  本机访问   ${scheme}://127.0.0.1:${PORT}`)
  if (openBind) {
    if (nets.length) {
      for (const ip of nets) console.log(`  内网访问   ${scheme}://${ip}:${PORT}/${ACCESS_CODE ? `?code=${ACCESS_CODE}` : ''}`)
    } else {
      console.log('  内网访问   未检测到可用内网网卡地址')
    }
    console.log(`  传输加密   ${TLS_ENABLED ? `已启用（证书 ${TLS_CERT}）` : '未启用（HTTP，建议配置 FORUM_TLS_CERT/FORUM_TLS_KEY）'}`)
    console.log(`  放行网段   ${ALLOW_CIDRS.join(' , ')}`)
    console.log(`  访问口令   ${ACCESS_CODE ? '已启用（?code=...）' : '未设置（建议设置 FORUM_ACCESS_CODE）'}`)
  } else {
    console.log(`  访问模式   仅本机回环（${HOST}），内网其他设备无法访问`)
  }
  console.log(`  账号上限   ${MAX_USERS} 人（当前 ${memberSummary().used} 人）`)
  console.log(`  帖子/回复  ${db.posts.length} 帖 / ${db.posts.reduce((n, p) => n + p.replies.length, 0)} 层`)
  if (storageInfo) {
    console.log(`  数据存储   MySQL ${storageInfo.version} · ${storageInfo.server} · 账号 ${storageInfo.user}${storageInfo.tablePrefix ? ` · 表前缀 ${storageInfo.tablePrefix}` : ''}`)
  } else {
    console.log(`  数据存储   ${storage.kind} · ${storage.describe()}`)
  }
  console.log('  排查提示   内网设备被拒时，该来源地址会打印在下方日志中，')
  console.log('             把它所在的网段加入 FORUM_ALLOW_CIDRS 即可放行。')
  console.log('')
  logLine(`服务已启动 http://${HOST}:${PORT} 存储 ${storage.kind} 账号 ${memberSummary().used}/${MAX_USERS} 帖子 ${db.posts.length}`)
}

