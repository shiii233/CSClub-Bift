/**
 * JSON 文件存储：与旧版行为一致（读入内存 + 原子写盘 + 防抖），
 * 作为本地开发与线上回退方案。
 */
import fs from 'node:fs'
import path from 'node:path'

export function createJsonStorage(dataDir, dataFile) {
  let timer = null

  function writeNow(db) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${dataFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    fs.renameSync(tmp, dataFile)
  }

  return {
    kind: 'json',
    describe() {
      return dataFile
    },
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
        return {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          posts: Array.isArray(parsed.posts) ? parsed.posts : [],
          seq: parsed.seq || { user: 0, post: 0, reply: 0 },
        }
      } catch {
        return { users: [], posts: [], seq: { user: 0, post: 0, reply: 0 } }
      }
    },
    /** 防抖落盘：高频发帖时不会每个请求都写文件 */
    persist(db) {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        try {
          writeNow(db)
        } catch (err) {
          console.error('[forum] 数据写入失败:', err.message)
        }
      }, 120)
    },
    /** 立即落盘（关闭前/自测清理用） */
    flush(db) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try {
        writeNow(db)
      } catch (err) {
        console.error('[forum] 数据写入失败:', err.message)
      }
    },
    close() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    /** 一次性清空（--clear） */
    wipe(db) {
      db.users = []
      db.posts = []
      db.seq = { user: 0, post: 0, reply: 0 }
      writeNow(db)
    },
  }
}
