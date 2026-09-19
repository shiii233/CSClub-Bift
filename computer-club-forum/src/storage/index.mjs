/**
 * 存储层入口：按 FORUM_STORE 选择实现。
 *   mysql  —— MySQL（阿里云服务器正式环境，驱动 mysql2）
 *   sqlite —— data/forum.db（单机备选，Node 内置 node:sqlite）
 *   json   —— data/forum.json（默认，本地开发/回退用）
 *
 * 注意：createStorage 可能是异步的（mysql 需要先连库建表），调用方必须 await。
 */
import path from 'node:path'
import { createJsonStorage } from './json.mjs'
import { createSqliteStorage } from './sqlite.mjs'
import { createMysqlStorage, readMysqlConfig, describeMysql } from './mysql.mjs'

export const KNOWN_STORES = ['mysql', 'sqlite', 'json']

export async function createStorage(options) {
  const kind = String(options.kind || 'json').toLowerCase()

  if (kind === 'mysql') {
    const mysql = options.mysql || readMysqlConfig()
    return createMysqlStorage({
      mysql,
      legacyJsonFile: options.legacyJsonFile,
      log: options.log,
    })
  }

  if (kind === 'sqlite') {
    return createSqliteStorage({
      file: options.dbFile,
      legacyJsonFile: options.legacyJsonFile,
    })
  }

  if (kind === 'json') {
    return createJsonStorage(path.dirname(options.jsonFile), options.jsonFile)
  }

  throw new Error(`未知的存储类型 FORUM_STORE=${kind}（只能是 ${KNOWN_STORES.join(' / ')}）`)
}

export { readMysqlConfig, describeMysql }
