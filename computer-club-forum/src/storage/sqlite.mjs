/**
 * SQLite 存储（Node 22+ 内置 node:sqlite，无需任何 npm 依赖）。
 *
 * 设计说明：
 *  - 读：启动时一次性载入内存（200 人规模数据量极小），业务逻辑零改动；
 *  - 写：每次变更在一个事务里整体重写全部表，保证原子性，杜绝 JSON 时代的"写一半"风险；
 *  - 首次启动会自动从旧版 data/forum.json 迁移，迁移后原文件保留作为备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  role          TEXT NOT NULL DEFAULT 'member',
  banned        INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY,
  board      TEXT NOT NULL,
  author     TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  images     TEXT NOT NULL DEFAULT '[]',
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  post_id    INTEGER NOT NULL,
  floor      INTEGER NOT NULL,
  author     TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  images     TEXT NOT NULL DEFAULT '[]',
  reply_to   INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, floor)
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_board  ON posts(board, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, floor);
`

function openDb(file) {
  // Node 22/23 下 node:sqlite 仍是实验特性，这里动态加载并容忍告警
  const sqlite = require('node:sqlite')
  const inMemory = file === ':memory:'
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new sqlite.DatabaseSync(file)
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}

export function createSqliteStorage({ file, legacyJsonFile }) {
  const db = openDb(file)

  function readAll() {
    const users = db.prepare(
      'SELECT username, role, banned, password_hash, created_at FROM users ORDER BY created_at ASC',
    ).all().map((r) => ({
      username: r.username,
      role: r.role,
      banned: !!r.banned,
      passwordHash: r.password_hash || null,
      createdAt: new Date(Number(r.created_at)).toISOString(),
    }))

    const posts = db.prepare(
      'SELECT id, board, author, title, content, images, pinned, created_at FROM posts ORDER BY id ASC',
    ).all().map((r) => ({
      id: Number(r.id),
      board: r.board,
      author: r.author,
      title: r.title,
      content: r.content,
      images: JSON.parse(r.images || '[]'),
      pinned: !!r.pinned,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      replies: [],
    }))

    const byId = new Map(posts.map((p) => [p.id, p]))
    const replies = db.prepare(
      'SELECT post_id, floor, author, content, images, reply_to, created_at FROM replies ORDER BY post_id ASC, floor ASC',
    ).all()
    for (const r of replies) {
      const post = byId.get(Number(r.post_id))
      if (!post) continue
      post.replies.push({
        floor: Number(r.floor),
        author: r.author,
        content: r.content,
        images: JSON.parse(r.images || '[]'),
        replyTo: r.reply_to === null || r.reply_to === undefined ? null : Number(r.reply_to),
        createdAt: new Date(Number(r.created_at)).toISOString(),
      })
    }

    const seqRow = db.prepare("SELECT value FROM meta WHERE key = 'seq'").get()
    const seq = seqRow ? JSON.parse(seqRow.value) : { user: 0, post: 0, reply: 0 }

    return { users, posts, seq }
  }

  /** 整体重写（一个事务，要么全成功要么全失败） */
  function writeAll(d) {
    // node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 transaction()，手动开事务
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.exec('DELETE FROM replies; DELETE FROM posts; DELETE FROM users;')
      const insUser = db.prepare(
        'INSERT INTO users (username, role, banned, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      for (const u of d.users) {
        insUser.run(u.username, u.role, u.banned ? 1 : 0, u.passwordHash || null, Date.parse(u.createdAt))
      }
      const insPost = db.prepare(
        'INSERT INTO posts (id, board, author, title, content, images, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const insReply = db.prepare(
        'INSERT INTO replies (post_id, floor, author, content, images, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const p of d.posts) {
        insPost.run(p.id, p.board, p.author, p.title || '', p.content || '', JSON.stringify(p.images || []), p.pinned ? 1 : 0, Date.parse(p.createdAt))
        for (const r of p.replies || []) {
          insReply.run(p.id, r.floor, r.author, r.content || '', JSON.stringify(r.images || []), r.replyTo ?? null, Date.parse(r.createdAt))
        }
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('seq', JSON.stringify(d.seq))
      db.exec('COMMIT;')
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        /* 回滚失败时保留原始异常 */
      }
      throw err
    }
  }

  function migrateFromJsonIfEmpty() {
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n)
    if (count > 0 || !legacyJsonFile || !fs.existsSync(legacyJsonFile)) return null
    let legacy
    try {
      legacy = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8'))
    } catch {
      return null
    }
    const data = {
      users: (legacy.users || []).map((u) => ({
        username: u.username,
        role: u.role || 'member',
        banned: !!u.banned,
        passwordHash: u.passwordHash || null,
        createdAt: u.createdAt || new Date().toISOString(),
      })),
      posts: (legacy.posts || []).map((p) => ({
        id: p.id,
        board: p.board,
        author: p.author,
        title: p.title || '',
        content: p.content || '',
        images: p.images || [],
        pinned: !!p.pinned,
        createdAt: p.createdAt || new Date().toISOString(),
        replies: (p.replies || []).map((r) => ({
          floor: r.floor,
          author: r.author,
          content: r.content || '',
          images: r.images || [],
          replyTo: r.replyTo ?? null,
          createdAt: r.createdAt || new Date().toISOString(),
        })),
      })),
      seq: legacy.seq || { user: 0, post: 0, reply: 0 },
    }
    writeAll(data)
    // 迁移后把旧文件改名留档，避免再次被当作迁移源
    try {
      fs.renameSync(legacyJsonFile, `${legacyJsonFile}.migrated`)
    } catch {
      /* 留档失败不影响运行 */
    }
    return { users: data.users.length, posts: data.posts.length, replies: data.posts.reduce((n, p) => n + p.replies.length, 0) }
  }

  return {
    kind: 'sqlite',
    describe() {
      return file
    },
    load() {
      const migrated = migrateFromJsonIfEmpty()
      if (migrated) {
        console.log(`[forum] 已从旧版 JSON 迁移到 SQLite：用户 ${migrated.users} / 帖子 ${migrated.posts} / 回复 ${migrated.replies}`)
      }
      return readAll()
    },
    persist(data) {
      writeAll(data)
    },
    flush(data) {
      writeAll(data)
    },

    /* ---------- 登录态（进程重启不掉线） ---------- */
    loadSessions(now = Date.now()) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      const rows = db.prepare('SELECT token, username FROM sessions').all()
      const map = new Map()
      for (const r of rows) map.set(r.token, { username: r.username })
      return map
    },
    saveSession(token, username, ttlMs) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET username = excluded.username, expires_at = excluded.expires_at',
      ).run(token, username, now, now + ttlMs)
    },
    dropSession(token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    },
    clearSessions() {
      db.exec('DELETE FROM sessions;')
    },
    /** 清理过期会话，返回清理条数 */
    pruneSessions(now = Date.now()) {
      const info = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      return Number(info.changes || 0)
    },
    sessionCount() {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n)
    },

    /* ---------- 运维 ---------- */
    wipe(data) {
      db.exec('DELETE FROM sessions; DELETE FROM replies; DELETE FROM posts; DELETE FROM users; DELETE FROM meta;')
      data.users = []
      data.posts = []
      data.seq = { user: 0, post: 0, reply: 0 }
      writeAll(data)
    },
    backup(targetFile) {
      db.exec(`VACUUM INTO '${String(targetFile).replace(/'/g, "''")}'`)
      return targetFile
    },
    close() {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    },
  }
}
