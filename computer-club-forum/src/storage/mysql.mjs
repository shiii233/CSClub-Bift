/**
 * MySQL 存储（阿里云服务器正式环境使用，驱动为 mysql2 连接池）。
 *
 * 设计说明（与 sqlite.mjs 保持一致，业务逻辑零改动）：
 *  - 读：启动时一次性载入内存（200 人规模数据量极小），接口层读到的是同一份内存数据；
 *  - 写：每次变更在一个事务里整体重写全部表，要么全成功要么全失败，杜绝"写一半"；
 *  - 首次启动若库里还没有用户，会自动从旧版 data/forum.json 迁移，迁移后原文件留档备份。
 *
 * 环境变量（可在 forum.env.cmd / systemd 环境文件里配置）：
 *   FORUM_MYSQL_HOST / FORUM_MYSQL_PORT / FORUM_MYSQL_USER / FORUM_MYSQL_PASSWORD
 *   FORUM_MYSQL_DATABASE / FORUM_MYSQL_TABLE_PREFIX
 *   FORUM_MYSQL_SSL=1 时启用 TLS；FORUM_MYSQL_SSL_CA 指定 CA 证书路径（阿里云 RDS 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 建表语句：与建库脚本 deploy/mysql/01-schema.sql 保持完全一致 */
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS {{p}}users (
  username      VARCHAR(64)  NOT NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'member',
  banned        TINYINT(1)   NOT NULL DEFAULT 0,
  password_hash VARCHAR(255) NULL,
  created_at    BIGINT       NOT NULL,
  PRIMARY KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS {{p}}posts (
  id         INT          NOT NULL,
  board      VARCHAR(32)  NOT NULL,
  author     VARCHAR(64)  NOT NULL,
  title      VARCHAR(255) NOT NULL DEFAULT '',
  content    TEXT         NOT NULL,
  images     TEXT         NOT NULL,
  pinned     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_posts_board (board, created_at),
  KEY idx_posts_author (author)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS {{p}}replies (
  post_id    INT          NOT NULL,
  floor      INT          NOT NULL,
  author     VARCHAR(64)  NOT NULL,
  content    TEXT         NOT NULL,
  images     TEXT         NOT NULL,
  reply_to   INT          NULL,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (post_id, floor),
  KEY idx_replies_author (author)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS {{p}}sessions (
  token      VARCHAR(128) NOT NULL,
  username   VARCHAR(64)  NOT NULL,
  created_at BIGINT       NOT NULL,
  expires_at BIGINT       NOT NULL,
  PRIMARY KEY (token),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS {{p}}meta (
  \`key\`   VARCHAR(64)  NOT NULL,
  value   TEXT         NOT NULL,
  PRIMARY KEY (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

/** 把 {{p}} 占位符替换成真实表前缀，得到可直接执行的建表语句 */
export function schemaStatements(prefix = '') {
  return SCHEMA_SQL.map((sql) => sql.replace(/\{\{p\}\}/g, prefix))
}

export function readMysqlConfig(env = process.env) {
  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  let tablePrefix = String(env.FORUM_MYSQL_TABLE_PREFIX || '').trim()
  if (tablePrefix && !/^[A-Za-z0-9_]+$/.test(tablePrefix)) {
    throw new Error('FORUM_MYSQL_TABLE_PREFIX 只允许字母、数字与下划线')
  }
  return {
    host: env.FORUM_MYSQL_HOST || '127.0.0.1',
    port: num(env.FORUM_MYSQL_PORT, 3306),
    user: env.FORUM_MYSQL_USER || 'root',
    password: env.FORUM_MYSQL_PASSWORD || '',
    database: env.FORUM_MYSQL_DATABASE || 'forum',
    tablePrefix,
    connectionLimit: num(env.FORUM_MYSQL_POOL_SIZE, 4),
    ssl:
      env.FORUM_MYSQL_SSL === '1'
        ? env.FORUM_MYSQL_SSL_CA
          ? { ca: fs.readFileSync(env.FORUM_MYSQL_SSL_CA, 'utf8') }
          : { rejectUnauthorized: true }
        : undefined,
  }
}

/** 动态加载 mysql2：未安装时给出可直接照抄的安装命令 */
async function loadMysqlDriver() {
  try {
    const mod = await import('mysql2/promise')
    return mod.default || mod
  } catch (err) {
    throw new Error(
      '未安装 MySQL 驱动 mysql2。请在项目目录执行：\n' +
        '  npm install mysql2 --registry=https://registry.npmmirror.com\n' +
        `（原始错误：${err && err.message ? err.message : err}）`,
    )
  }
}

/**
 * 把 conf 转成不泄露口令的描述文本，用于启动横幅、/healthz 与 /api/access。
 */
export function describeMysql(conf) {
  const where = `${conf.host}:${conf.port}/${conf.database}`
  return conf.ssl ? `${where}（TLS）` : where
}

/**
 * 创建 MySQL 存储。config 形如：
 *   { mysql: <readMysqlConfig 的结果>, legacyJsonFile: 'data/forum.json', log: fn }
 */
export async function createMysqlStorage(config = {}) {
  const conf = config.mysql || readMysqlConfig()
  const legacyJsonFile = config.legacyJsonFile || ''
  const log = typeof config.log === 'function' ? config.log : (m) => console.log(m)
  const P = conf.tablePrefix || ''
  const T = {
    users: `${P}users`,
    posts: `${P}posts`,
    replies: `${P}replies`,
    sessions: `${P}sessions`,
    meta: `${P}meta`,
  }

  const mysql = await loadMysqlDriver()
  const pool = mysql.createPool({
    host: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    database: conf.database,
    ssl: conf.ssl,
    connectionLimit: conf.connectionLimit,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    charset: 'utf8mb4_general_ci',
    decimalNumbers: true,
    dateStrings: true,
    connectTimeout: 15_000,
  })

  // 启动即验证连接与建表，连不上直接抛出，避免"服务起来了但库是坏的"
  let version = ''
  try {
    const [row] = await pool.query('SELECT VERSION() AS v')
    version = String(row[0].v)
    for (const sql of schemaStatements(conf.tablePrefix)) await pool.query(sql)
  } catch (err) {
    await pool.end().catch(() => {})
    throw new Error(
      `连接 MySQL 失败（${describeMysql(conf)}）：${err && err.message ? err.message : err}\n` +
        '请检查：1) MySQL 服务是否已启动 2) 库是否已创建（deploy/mysql/01-schema.sql）\n' +
        '        3) FORUM_MYSQL_USER / FORUM_MYSQL_PASSWORD 是否正确 4) 防火墙是否放行 3306',
    )
  }

  /** 会话数在内存里计数，保证 /healthz 这种同步读取接口也能拿到值 */
  let sessionTotal = 0

  async function readAll(conn = pool) {
    const [userRows] = await conn.query(
      `SELECT username, role, banned, password_hash, created_at FROM ${T.users} ORDER BY created_at ASC, username ASC`,
    )
    const users = userRows.map((r) => ({
      username: r.username,
      role: r.role,
      banned: !!Number(r.banned),
      passwordHash: r.password_hash || null,
      createdAt: new Date(Number(r.created_at)).toISOString(),
    }))

    const [postRows] = await conn.query(
      `SELECT id, board, author, title, content, images, pinned, created_at FROM ${T.posts} ORDER BY id ASC`,
    )
    const posts = postRows.map((r) => ({
      id: Number(r.id),
      board: r.board,
      author: r.author,
      title: r.title,
      content: r.content,
      images: safeJson(r.images, []),
      pinned: !!Number(r.pinned),
      createdAt: new Date(Number(r.created_at)).toISOString(),
      replies: [],
    }))

    const byId = new Map(posts.map((p) => [p.id, p]))
    const [replyRows] = await conn.query(
      `SELECT post_id, floor, author, content, images, reply_to, created_at FROM ${T.replies} ORDER BY post_id ASC, floor ASC`,
    )
    for (const r of replyRows) {
      const post = byId.get(Number(r.post_id))
      if (!post) continue
      post.replies.push({
        floor: Number(r.floor),
        author: r.author,
        content: r.content,
        images: safeJson(r.images, []),
        replyTo: r.reply_to === null || r.reply_to === undefined ? null : Number(r.reply_to),
        createdAt: new Date(Number(r.created_at)).toISOString(),
      })
    }

    const [seqRows] = await conn.query(`SELECT value FROM ${T.meta} WHERE \`key\` = 'seq'`)
    const seq = seqRows.length ? safeJson(seqRows[0].value, null) : null

    return {
      users,
      posts,
      seq: seq && typeof seq === 'object' ? { user: seq.user || 0, post: seq.post || 0, reply: seq.reply || 0 } : { user: 0, post: 0, reply: 0 },
    }
  }

  /** 整体重写：一个事务，要么全成功要么全失败 */
  async function writeAll(d) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query(`DELETE FROM ${T.replies}`)
      await conn.query(`DELETE FROM ${T.posts}`)
      await conn.query(`DELETE FROM ${T.users}`)

      if (d.users.length) {
        const rows = d.users.map((u) => [
          u.username,
          u.role || 'member',
          u.banned ? 1 : 0,
          u.passwordHash || null,
          Date.parse(u.createdAt) || Date.now(),
        ])
        await conn.query(
          `INSERT INTO ${T.users} (username, role, banned, password_hash, created_at) VALUES ?`,
          [rows],
        )
      }

      if (d.posts.length) {
        const postRows = d.posts.map((p) => [
          Number(p.id),
          p.board,
          p.author,
          p.title || '',
          p.content || '',
          JSON.stringify(p.images || []),
          p.pinned ? 1 : 0,
          Date.parse(p.createdAt) || Date.now(),
        ])
        await conn.query(
          `INSERT INTO ${T.posts} (id, board, author, title, content, images, pinned, created_at) VALUES ?`,
          [postRows],
        )

        const replyRows = []
        for (const p of d.posts) {
          for (const r of p.replies || []) {
            replyRows.push([
              Number(p.id),
              Number(r.floor),
              r.author,
              r.content || '',
              JSON.stringify(r.images || []),
              r.replyTo === null || r.replyTo === undefined ? null : Number(r.replyTo),
              Date.parse(r.createdAt) || Date.now(),
            ])
          }
        }
        if (replyRows.length) {
          await conn.query(
            `INSERT INTO ${T.replies} (post_id, floor, author, content, images, reply_to, created_at) VALUES ?`,
            [replyRows],
          )
        }
      }

      await conn.query(
        `INSERT INTO ${T.meta} (\`key\`, value) VALUES ('seq', ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [JSON.stringify(d.seq || { user: 0, post: 0, reply: 0 })],
      )
      await conn.commit()
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  }

  /** 库还是空的、且存在旧版 forum.json 时，自动迁移一次 */
  async function migrateFromJsonIfEmpty() {
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.users}`)
    if (Number(rows[0].n) > 0) return null
    if (!legacyJsonFile || !fs.existsSync(legacyJsonFile)) return null
    let legacy
    try {
      legacy = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8'))
    } catch {
      return null
    }
    const data = normalizeLegacy(legacy)
    if (!data.users.length && !data.posts.length) return null
    await writeAll(data)
    try {
      fs.renameSync(legacyJsonFile, `${legacyJsonFile}.migrated`)
    } catch {
      /* 留档失败不影响运行 */
    }
    return {
      users: data.users.length,
      posts: data.posts.length,
      replies: data.posts.reduce((n, p) => n + p.replies.length, 0),
    }
  }

  return {
    kind: 'mysql',
    async: true,
    describe() {
      return describeMysql(conf)
    },
    /** 供启动横幅 / 运维命令展示 */
    info() {
      return {
        host: conf.host,
        port: conf.port,
        database: conf.database,
        user: conf.user,
        tablePrefix: conf.tablePrefix,
        version,
        server: describeMysql(conf),
      }
    },
    /** 连通性探针（/healthz 用），返回 MySQL 版本号 */
    async ping() {
      const [row] = await pool.query('SELECT VERSION() AS v')
      return String(row[0].v)
    },
    async load() {
      const migrated = await migrateFromJsonIfEmpty()
      if (migrated) {
        log(
          `[forum] 已从旧版 JSON 迁移到 MySQL：用户 ${migrated.users} / 帖子 ${migrated.posts} / 回复 ${migrated.replies}`,
        )
      }
      return readAll()
    },
    async persist(data) {
      await writeAll(data)
    },
    async flush(data) {
      await writeAll(data)
    },

    /* ---------- 登录态（进程重启不掉线） ---------- */
    async loadSessions(now = Date.now()) {
      await pool.query(`DELETE FROM ${T.sessions} WHERE expires_at <= ?`, [now])
      const [rows] = await pool.query(`SELECT token, username FROM ${T.sessions}`)
      const map = new Map()
      for (const r of rows) map.set(r.token, { username: r.username })
      sessionTotal = map.size
      return map
    },
    async saveSession(token, username, ttlMs) {
      const now = Date.now()
      const [info] = await pool.query(
        `INSERT INTO ${T.sessions} (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), expires_at = VALUES(expires_at)`,
        [token, username, now, now + ttlMs],
      )
      // affectedRows：插入=1，更新=2，未变化=0
      if (Number(info.affectedRows) === 1) sessionTotal += 1
    },
    async dropSession(token) {
      const [info] = await pool.query(`DELETE FROM ${T.sessions} WHERE token = ?`, [token])
      sessionTotal = Math.max(0, sessionTotal - Number(info.affectedRows || 0))
    },
    async clearSessions() {
      await pool.query(`DELETE FROM ${T.sessions}`)
      sessionTotal = 0
    },
    async pruneSessions(now = Date.now()) {
      const [info] = await pool.query(`DELETE FROM ${T.sessions} WHERE expires_at <= ?`, [now])
      const n = Number(info.affectedRows || 0)
      sessionTotal = Math.max(0, sessionTotal - n)
      return n
    },
    sessionCount() {
      return sessionTotal
    },

    /* ---------- 运维 ---------- */
    async wipe(data) {
      await pool.query(`DELETE FROM ${T.sessions}`)
      await pool.query(`DELETE FROM ${T.replies}`)
      await pool.query(`DELETE FROM ${T.posts}`)
      await pool.query(`DELETE FROM ${T.users}`)
      data.users = []
      data.posts = []
      data.seq = { user: 0, post: 0, reply: 0 }
      await writeAll(data)
      sessionTotal = 0
    },
    /**
     * 备份：优先用 mysqldump 产出标准 SQL；没有 mysqldump.exe 时退化为
     * 「数据快照 SQL」（CREATE TABLE + INSERT），任何权限下都能跑，可恢复到空库。
     */
    async backup(targetFile) {
      const tables = [T.users, T.posts, T.replies, T.sessions, T.meta]
      const mysqldump = findMysqldump()
      if (mysqldump) {
        await runMysqldump(mysqldump, conf, tables, targetFile)
        return targetFile
      }
      const snapshot = await buildSnapshotSql(pool, conf, tables)
      fs.mkdirSync(path.dirname(targetFile), { recursive: true })
      fs.writeFileSync(targetFile, snapshot, 'utf8')
      return targetFile
    },
    async close() {
      await pool.end().catch(() => {})
    },
  }
}

/* ------------------------------ 内部工具 ------------------------------ */

function safeJson(text, fallback) {
  if (text === null || text === undefined) return fallback
  if (typeof text === 'object') return text
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 把旧版 forum.json 的数据规整成内存数据模型 */
export function normalizeLegacy(legacy) {
  return {
    users: (legacy.users || []).map((u) => ({
      username: u.username,
      role: u.role || 'member',
      banned: !!u.banned,
      passwordHash: u.passwordHash || null,
      createdAt: u.createdAt || new Date().toISOString(),
    })),
    posts: (legacy.posts || []).map((p) => ({
      id: Number(p.id),
      board: p.board,
      author: p.author,
      title: p.title || '',
      content: p.content || '',
      images: p.images || [],
      pinned: !!p.pinned,
      createdAt: p.createdAt || new Date().toISOString(),
      replies: (p.replies || []).map((r) => ({
        floor: Number(r.floor),
        author: r.author,
        content: r.content || '',
        images: r.images || [],
        replyTo: r.replyTo === null || r.replyTo === undefined ? null : Number(r.replyTo),
        createdAt: r.createdAt || new Date().toISOString(),
      })),
    })),
    seq: legacy.seq || { user: 0, post: 0, reply: 0 },
  }
}

/** 在常见安装路径里找 mysqldump.exe（Windows 安装包默认路径） */
export function findMysqldump() {
  if (process.env.FORUM_MYSQLDUMP && fs.existsSync(process.env.FORUM_MYSQLDUMP)) return process.env.FORUM_MYSQLDUMP
  const candidates = [
    'C:\\mysql\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin\\mysqldump.exe',
    'C:\\Program Files\\MariaDB 10.11\\bin\\mysqldump.exe',
    '/usr/bin/mysqldump',
    '/usr/local/mysql/bin/mysqldump',
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* 忽略 */
    }
  }
  return null
}

function runMysqldump(exe, conf, tables, targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true })
  const out = fs.createWriteStream(targetFile, { encoding: 'utf8' })
  const args = [
    `--host=${conf.host}`,
    `--port=${conf.port}`,
    `--user=${conf.user}`,
    '--single-transaction',
    '--default-character-set=utf8mb4',
    '--skip-lock-tables',
    '--add-drop-table',
    ...(conf.ssl ? ['--ssl-mode=REQUIRED'] : []),
    conf.database,
    ...tables,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: { ...process.env, MYSQL_PWD: conf.password || '' },
      windowsHide: true,
    })
    let errText = ''
    child.stdout.pipe(out)
    child.stderr.on('data', (c) => {
      errText += c
    })
    child.on('error', reject)
    child.on('close', (code) => {
      out.end()
      if (code === 0) return resolve(targetFile)
      reject(new Error(`mysqldump 退出码 ${code}：${errText.trim().slice(0, 400)}`))
    })
  })
}

/** 生成「数据快照 SQL」：结构 + 数据，可在任意空库上执行还原 */
async function buildSnapshotSql(pool, conf, tables) {
  const lines = [
    '-- 计算机社交流论坛 · MySQL 数据快照备份',
    `-- 生成时间：${new Date().toISOString()}`,
    `-- 来源库：${describeMysql(conf)}`,
    '-- 还原：mysql -u root -p 你的库名 < 本文件',
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS = 0;',
    '',
  ]
  for (const sql of schemaStatements(conf.tablePrefix)) {
    // 还原时先删后建，避免往已有数据的库里插出主键冲突
    const name = /CREATE TABLE IF NOT EXISTS\s+(\S+)\s*\(/.exec(sql)
    if (name) lines.push(`DROP TABLE IF EXISTS ${name[1]};`)
    lines.push(`${sql};`, '')
  }
  for (const table of tables) {
    const [rows] = await pool.query(`SELECT * FROM ${table}`)
    if (!rows.length) continue
    const cols = Object.keys(rows[0])
    lines.push(`-- ${table}：${rows.length} 行`)
    const colList = cols.map((c) => `\`${c}\``).join(', ')
    // 分块插入，避免单条 SQL 过长
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
      const values = chunk
        .map((row) => `(${cols.map((c) => sqlLiteral(row[c])).join(', ')})`)
        .join(',\n  ')
      lines.push(`INSERT INTO ${table} (${colList}) VALUES\n  ${values};`)
    }
    lines.push('')
  }
  lines.push('SET FOREIGN_KEY_CHECKS = 1;', '')
  return lines.join('\n')
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
  return `'${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}'`
}
