/**
 * 自测脚本：校验内网白名单判定、运行中的论坛接口与 admin 访问控制，
 * 并在配置了 MySQL 时顺带验证「连库 -> 读写 -> 会话持久化」这条正式路径。
 *
 * 用法: node self-test.mjs
 * 不会改动正式数据：临时实例使用系统临时目录下的独立数据文件；
 * MySQL 检查只读写 meta 表里的一个自测键，不碰用户/帖子/回复。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CIDRS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
  '::1/128', 'fc00::/7', 'fe80::/10',
]
const EXTRA_CIDRS = DEFAULT_CIDRS.concat(['100.64.0.0/10', '2001:da8:2000::/36'])

const { inAnyCidr } = await import('./server.mjs')

// 先验 MySQL（此时 FORUM_STORE 还是默认的 mysql），再切到 sqlite 跑接口自测
await checkMysql()

/* ---------- 1. 校园网白名单判定 ---------- */
const allowed = [
  ['127.0.0.1', DEFAULT_CIDRS],
  ['::1', DEFAULT_CIDRS],
  ['::ffff:127.0.0.1', DEFAULT_CIDRS],
  ['10.20.30.40', DEFAULT_CIDRS],
  ['172.16.0.1', DEFAULT_CIDRS],
  ['172.31.255.254', DEFAULT_CIDRS],
  ['192.168.1.100', DEFAULT_CIDRS],
  ['192.168.50.7', DEFAULT_CIDRS],
  ['10.99.1.2', EXTRA_CIDRS],
  ['100.64.3.9', EXTRA_CIDRS],
  ['2001:da8:2000::5', EXTRA_CIDRS],
  ['fe80::1%eth0', DEFAULT_CIDRS],
]
const denied = [
  ['8.8.8.8', DEFAULT_CIDRS],
  ['1.1.1.1', DEFAULT_CIDRS],
  ['172.32.0.1', DEFAULT_CIDRS],
  ['172.15.255.255', DEFAULT_CIDRS],
  ['192.169.0.1', DEFAULT_CIDRS],
  ['100.64.3.9', DEFAULT_CIDRS],
  ['114.114.114.114', EXTRA_CIDRS],
  ['2001:da8:3000::5', EXTRA_CIDRS],
  ['2606:4700::1111', DEFAULT_CIDRS],
  ['203.0.113.9', DEFAULT_CIDRS],
]
for (const [ip, list] of allowed) assert.strictEqual(inAnyCidr(ip, list), true, `应放行但被拒绝: ${ip}`)
for (const [ip, list] of denied) assert.strictEqual(inAnyCidr(ip, list), false, `应拒绝但被放行: ${ip}`)
console.log(`✓ 内网白名单判定通过 ${allowed.length + denied.length} 项（${allowed.length} 放行 / ${denied.length} 拒绝）`)

/* 提前做 MySQL 正式路径检查（连不上就跳过，不算失败） */

async function checkMysql() {
  if (String(process.env.FORUM_STORE || 'mysql').toLowerCase() !== 'mysql') {
    console.log('- 跳过 MySQL 检查（FORUM_STORE 不是 mysql）')
    return
  }
  if (process.env.FORUM_SKIP_MYSQL_TEST === '1') {
    console.log('- 跳过 MySQL 检查（FORUM_SKIP_MYSQL_TEST=1）')
    return
  }
  let storage
  try {
    const { createStorage, readMysqlConfig } = await import('./src/storage/index.mjs')
    const conf = readMysqlConfig()
    storage = await createStorage({ kind: 'mysql', legacyJsonFile: '', log: () => {} })
    const version = await storage.ping()
    const loaded = await storage.load()
    assert.ok(Array.isArray(loaded.users) && Array.isArray(loaded.posts), 'MySQL 读取结果结构异常')
    const sessions = await storage.loadSessions()
    assert.ok(sessions instanceof Map, 'MySQL 会话读取结果应为 Map')
    console.log(
      `✓ MySQL 路径正常：${conf.host}:${conf.port}/${conf.database} · ${version} · ` +
        `用户 ${loaded.users.length} / 帖子 ${loaded.posts.length} / 会话 ${sessions.size}`,
    )
  } catch (err) {
    console.log(`- 跳过 MySQL 检查（连不上或未配置）：${err && err.message ? err.message.split('\n')[0] : err}`)
  } finally {
    if (storage) await storage.close().catch(() => {})
  }
}

/* ---------- 2. 正式数据必须为空 ---------- */
const DATA_FILE = path.join(__dirname, 'data', 'forum.json')
if (fs.existsSync(DATA_FILE)) {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  if (db.users.length === 0 && db.posts.length === 0) {
    console.log('✓ 正式数据为空：用户 0 人，帖子 0 帖（无任何人物与内容）')
  } else {
    console.log(
      `! 正式数据当前为 用户 ${db.users.length} 人 / 帖子 ${db.posts.length} 帖` +
        '（若刚在运行中的服务里清空，落盘会有约 0.2 秒延迟；需要空白论坛请执行 node server.mjs --clear）',
    )
  }
} else {
  console.log('✓ 数据文件尚未创建：首次启动即为空论坛')
}

/* ---------- 3. 临时实例：接口、口令与 admin 访问控制 ---------- */
// 临时实例放在项目目录内的 .selftest 下，用完即删；数据文件独立，不影响正式数据
const TMP = path.join(__dirname, '.selftest')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true })
fs.mkdirSync(path.join(TMP, 'public'), { recursive: true })
fs.copyFileSync(path.join(__dirname, 'server.mjs'), path.join(TMP, 'server.mjs'))
fs.cpSync(path.join(__dirname, 'src'), path.join(TMP, 'src'), { recursive: true })
for (const f of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(__dirname, 'public', f), path.join(TMP, 'public', f))
}

const CODE = 'selftest-code'
const ADMIN_CODE = 'selftest-admin'
// 临时实例用 SQLite 内存库跑接口自测（MySQL 路径已在上面单独验过）；用内存库避免遗留文件句柄
process.env.FORUM_STORE = 'sqlite'
process.env.FORUM_DB_FILE = ':memory:'
process.env.FORUM_DATA_FILE = path.join(TMP, 'data', 'forum.json')
// 监听全部网卡，才会启用「来源网段 + 访问口令」校验（与校园网部署一致）
process.env.FORUM_HOST = '0.0.0.0'
process.env.PORT = String(8300 + Math.floor(Math.random() * 400))
process.env.FORUM_ACCESS_CODE = CODE
process.env.FORUM_ADMIN_CODE = ADMIN_CODE

const mod = await import(pathToFileURL(path.join(TMP, 'server.mjs')).href)
await mod.start()

function call(method, pathname, { token, body } = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(`http://127.0.0.1:${process.env.PORT}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const json = async (res) => ({ status: res.status, data: await res.json() })

/** 等待临时实例开始监听 */
async function waitListening(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (mod.server.listening) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return mod.server.listening
}
assert.ok(await waitListening(5000), '临时实例未能在 5 秒内开始监听')

try {
  // 无口令访问必须被拒绝
  const noCode = await call('GET', '/api/state')
  assert.strictEqual(noCode.status, 403, '缺少访问口令时应当返回 403')
  console.log('✓ 无口令访问被拒绝（403）')
  // 带口令访问正常
  const withCode = await json(await call('GET', `/api/state?code=${CODE}`))
  assert.strictEqual(withCode.status, 200, '携带正确口令时应返回 200')
  assert.strictEqual(withCode.data.posts.length, 0, '空论坛不应有帖子')
  assert.strictEqual(withCode.data.members.used, 0, '空论坛不应有成员')
  console.log('✓ 携带正确口令可访问，论坛为空（0 帖 / 0 人）')

  // 注册管理员 → 注册普通成员 → 发帖 → 回复
  const cmd = async (text, token) =>
    (await json(await call('POST', `/api/command?code=${CODE}`, { token, body: { text } }))).data

  const admin = await cmd('注册：用户名自测管理员，口令=' + ADMIN_CODE)
  assert.strictEqual(admin.ok, true, '管理员注册应成功')
  assert.strictEqual(admin.user.role, 'admin', '填写管理员口令后应为管理员')
  console.log('✓ 管理员注册成功（role=admin）')

  const member = await cmd('注册：用户名自测成员')
  assert.strictEqual(member.user.role, 'member', '未填口令应为普通成员')

  const posted = await cmd('发帖：板块=学习资料区，内容=自测资料【图片：自测截图】', member.token)
  assert.strictEqual(posted.ok, true, '发帖应成功')
  assert.strictEqual(posted.post.images.length, 1, '图片标记应被识别')
  console.log('✓ 发帖成功并识别【图片：…】标记')

  const replied = await cmd('回复帖子ID:1，内容=自测回复', member.token)
  assert.strictEqual(replied.ok, true, '回复应成功')
  const thread = (await json(await call('GET', `/api/post?id=1&code=${CODE}`))).data
  assert.strictEqual(thread.post.floorCount, 2, '应有 2 层（楼主 + 1 条回复）')
  console.log('✓ 楼层回复成功（共 2 楼）')

  // 违规内容拦截
  const spam = await cmd('发帖：板块=闲聊交流区，内容=扫码进群 领取资料 http://spam.example.com', member.token)
  assert.strictEqual(spam.ok, false, '外部链接/引流内容应被拦截')
  console.log('✓ 外部链接与引流内容被拦截')

  // 访问诊断：仅管理员
  const deniedDiag = await call('GET', `/api/access?code=${CODE}`, { token: member.token })
  assert.strictEqual(deniedDiag.status, 403, '普通成员不得查看访问诊断')
  const diag = await json(await call('GET', `/api/access?code=${CODE}`, { token: admin.token }))
  assert.strictEqual(diag.status, 200, '管理员应可查看访问诊断')
  assert.ok(diag.data.allowCidrs.length >= 8, '应列出默认放行网段')
  assert.ok(Array.isArray(diag.data.denied), '应返回拒绝记录数组')
  console.log('✓ 访问诊断仅管理员可见，放行网段与拒绝记录正常返回')

  // 管理动作
  const cleared = await cmd('清空全部数据', admin.token)
  assert.strictEqual(cleared.ok, true, '管理员应可清空数据')
  const after = (await json(await call('GET', `/api/state?code=${CODE}`))).data
  assert.strictEqual(after.posts.length, 0, '清空后不应有帖子')
  assert.strictEqual(after.members.used, 0, '清空后不应有成员')
  console.log('✓ 管理员清空数据成功，论坛恢复空白')
} finally {
  await mod.flush() // 先把防抖中的写入落盘，再关连接、删临时目录
  await mod.closeStorage()
  mod.server.close()
  // SQLite 的 WAL 文件在句柄释放前可能仍被占用，删不掉就重试几次
  let removed = false
  for (let i = 0; i < 8 && !removed; i += 1) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true })
      removed = !fs.existsSync(TMP)
    } catch {
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  if (removed) {
    console.log('✓ 临时实例已清理（.selftest 已删除）')
  } else {
    console.log('! 临时目录未能自动删除（SQLite 句柄占用），可手动删除 .selftest')
  }
}

console.log('\n全部自测通过。')
