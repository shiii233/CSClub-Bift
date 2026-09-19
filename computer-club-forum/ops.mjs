/**
 * 运维命令行：迁移、体检、备份、建库。
 *
 * 用法（默认针对 MySQL，连接参数取自 FORUM_MYSQL_* 环境变量）：
 *   node ops.mjs status                打印当前存储状态（用户/帖子/回复/会话）
 *   node ops.mjs verify                校验存储可读且数据自洽
 *   node ops.mjs migrate               把 data/forum.json 迁进 MySQL（幂等：库里已有用户则跳过）
 *   node ops.mjs backup [目录]         备份数据库到 目录/forum-YYYYMMDD-HHmmss.sql（无 mysqldump 时导出数据快照 SQL）
 *   node ops.mjs schema [前缀]         打印建表 SQL（不执行），用于手工在目标库执行
 *   node ops.mjs ping                  只测数据库连通性并打印版本
 *
 * 按需切换存储（默认 mysql）：
 *   node ops.mjs status --store sqlite
 *   node ops.mjs status --store json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.FORUM_DATA_DIR || path.join(__dirname, 'data')
const JSON_FILE = process.env.FORUM_DATA_FILE || path.join(DATA_DIR, 'forum.json')
const DB_FILE = process.env.FORUM_DB_FILE || path.join(DATA_DIR, 'forum.db')

const { createStorage, readMysqlConfig, describeMysql } = await import('./src/storage/index.mjs')
const { schemaStatements } = await import('./src/storage/mysql.mjs')

const argv = process.argv.slice(2).filter((a) => a !== '--')
const flagIndex = argv.findIndex((a) => a === '--store')
const STORE_KIND = (flagIndex >= 0 ? argv[flagIndex + 1] : process.env.FORUM_STORE || 'mysql').toLowerCase()
if (flagIndex >= 0) argv.splice(flagIndex, 2)
const cmd = (argv[0] || 'status').toLowerCase()

function stats(db) {
  const replies = db.posts.reduce((n, p) => n + (p.replies ? p.replies.length : 0), 0)
  const banned = db.users.filter((u) => u.banned).length
  const withPassword = db.users.filter((u) => u.passwordHash).length
  return { users: db.users.length, banned, withPassword, posts: db.posts.length, replies }
}

function printWhere(storage) {
  if (storage.kind === 'mysql') {
    const conf = readMysqlConfig()
    console.log(`存储类型：mysql`)
    console.log(`数据库  ：${describeMysql(conf)}（账号 ${conf.user}${conf.tablePrefix ? `，表前缀 ${conf.tablePrefix}` : ''}）`)
    return
  }
  if (storage.kind === 'sqlite') {
    console.log(`存储类型：sqlite`)
    console.log(`数据库  ：${DB_FILE}（${fs.existsSync(DB_FILE) ? `${(fs.statSync(DB_FILE).size / 1024).toFixed(1)} KB` : '不存在'}）`)
    return
  }
  console.log(`存储类型：json`)
  console.log(`数据文件：${JSON_FILE}（${fs.existsSync(JSON_FILE) ? `${(fs.statSync(JSON_FILE).size / 1024).toFixed(1)} KB` : '不存在'}）`)
}

/* schema / ping 不需要走完整存储层 */
if (cmd === 'schema') {
  const prefix = argv[1] || readMysqlConfig().tablePrefix || ''
  console.log(`-- 计算机社交流论坛建表 SQL（表前缀：${prefix || '无'}）`)
  console.log(`-- 执行方式：mysql -u root -p 你的库名 < deploy/mysql/01-schema.sql`)
  console.log('')
  console.log(schemaStatements(prefix).map((s) => `${s};`).join('\n\n'))
  process.exit(0)
}

if (cmd === 'ping') {
  if (STORE_KIND !== 'mysql') {
    console.log(`--store ${STORE_KIND} 不需要连通性测试`)
    process.exit(0)
  }
  const conf = readMysqlConfig()
  const storage = await createStorage({ kind: 'mysql', legacyJsonFile: '', log: () => {} })
  try {
    console.log(`MySQL 连接正常：${describeMysql(conf)} · 版本 ${await storage.ping()}`)
  } finally {
    await storage.close()
  }
  process.exit(0)
}

const storage = await createStorage({
  kind: STORE_KIND,
  jsonFile: JSON_FILE,
  dbFile: DB_FILE,
  legacyJsonFile: JSON_FILE,
})

try {
  if (cmd === 'migrate') {
    const db = await storage.load() // 内部：库为空且存在 forum.json 时自动迁移
    const s = stats(db)
    printWhere(storage)
    console.log(`迁移结果：用户 ${s.users}（含密码 ${s.withPassword}） / 帖子 ${s.posts} / 回复 ${s.replies}`)
    if (fs.existsSync(`${JSON_FILE}.migrated`)) console.log(`旧 JSON 已留档：${JSON_FILE}.migrated`)
    else if (fs.existsSync(JSON_FILE)) console.log(`未发生迁移（库里已有数据或 JSON 为空）：${JSON_FILE}`)
  } else if (cmd === 'status' || cmd === 'verify') {
    const db = await storage.load()
    const s = stats(db)
    printWhere(storage)
    console.log(`用户    ：${s.users} 人（封禁 ${s.banned}，已设密码 ${s.withPassword}）`)
    console.log(`帖子    ：${s.posts} 帖 / ${s.replies} 层回复`)
    console.log(`会话    ：${typeof storage.sessionCount === 'function' ? storage.sessionCount() : 0} 个有效登录态`)
    if (cmd === 'verify') {
      const badAuthor = db.posts.filter((p) => !db.users.some((u) => u.username === p.author))
      const badFloor = db.posts.filter((p) => (p.replies || []).some((r) => !(r.floor >= 2)))
      if (badAuthor.length || badFloor.length) {
        console.log(`校验发现问题：孤儿帖子 ${badAuthor.length} 帖，楼层号异常 ${badFloor.length} 帖`)
        process.exitCode = 1
      } else {
        console.log('校验通过：作者与楼层号自洽。')
      }
    }
  } else if (cmd === 'backup') {
    const dir = argv[1] || path.join(__dirname, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    const ext = STORE_KIND === 'sqlite' ? 'db' : STORE_KIND === 'json' ? 'json' : 'sql'
    const target = path.join(dir, `forum-${stamp}.${ext}`)
    if (STORE_KIND === 'sqlite' && !fs.existsSync(DB_FILE)) throw new Error(`数据库不存在：${DB_FILE}`)
    if (STORE_KIND === 'json') {
      if (!fs.existsSync(JSON_FILE)) throw new Error(`数据文件不存在：${JSON_FILE}`)
      fs.copyFileSync(JSON_FILE, target)
    } else {
      await storage.backup(target)
    }
    console.log(`已备份到：${target}`)
    // 只保留最近 7 份
    const all = fs.readdirSync(dir).filter((f) => new RegExp(`^forum-\\d+\\.${ext}$`).test(f)).sort()
    for (const old of all.slice(0, Math.max(0, all.length - 7))) {
      fs.unlinkSync(path.join(dir, old))
      console.log(`已清理旧备份：${old}`)
    }
  } else {
    console.log('用法：node ops.mjs status|verify|migrate|backup|schema|ping [参数] [--store mysql|sqlite|json]')
    process.exitCode = 1
  }
} finally {
  await storage.close()
}
