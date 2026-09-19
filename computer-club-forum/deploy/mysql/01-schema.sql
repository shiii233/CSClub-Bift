-- ============================================================
--  计算机社交流论坛 · MySQL 建库建表脚本
--  适用：阿里云 ECS 上自装的 MySQL 8.0 / 阿里云 RDS MySQL 8.0
--
--  执行方式（二选一）：
--    A. 命令行：mysql -u root -p < 01-schema.sql
--    B. 图形化：Workbench / Navicat / DMS 里打开本文件，全文执行
--
--  说明：
--    1) 本脚本只建「库 + 表」，不改动其它库；重复执行安全（IF NOT EXISTS）。
--    2) 表结构由应用启动时自动校验/补建，本脚本主要用于「先手工建库」的场景。
--    3) forum_app 账号的口令请改成你自己的强口令，并同步写进 forum.env.cmd。
--       如果只想用 root 连接，可以跳过 CREATE USER / GRANT 两段。
-- ============================================================

-- ---------- 1. 建库（字符集必须是 utf8mb4，否则中文昵称与帖子会乱码） ----------
CREATE DATABASE IF NOT EXISTS `forum`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- ---------- 2. 专用账号（最小权限：只动 forum 库） ----------
-- 把 'ChangeMe_Forum_2026' 换成你自己的强口令
CREATE USER IF NOT EXISTS 'forum_app'@'localhost' IDENTIFIED BY 'ChangeMe_Forum_2026';
CREATE USER IF NOT EXISTS 'forum_app'@'127.0.0.1' IDENTIFIED BY 'ChangeMe_Forum_2026';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, DROP
  ON `forum`.* TO 'forum_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, DROP
  ON `forum`.* TO 'forum_app'@'127.0.0.1';

FLUSH PRIVILEGES;

-- ---------- 3. 建表 ----------
USE `forum`;

CREATE TABLE IF NOT EXISTS `users` (
  username      VARCHAR(64)  NOT NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'member',
  banned        TINYINT(1)   NOT NULL DEFAULT 0,
  password_hash VARCHAR(255) NULL,
  created_at    BIGINT       NOT NULL,
  PRIMARY KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `posts` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `replies` (
  post_id    INT          NOT NULL,
  floor      INT          NOT NULL,
  author     VARCHAR(64)  NOT NULL,
  content    TEXT         NOT NULL,
  images     TEXT         NOT NULL,
  reply_to   INT          NULL,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (post_id, floor),
  KEY idx_replies_author (author)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sessions` (
  token      VARCHAR(128) NOT NULL,
  username   VARCHAR(64)  NOT NULL,
  created_at BIGINT       NOT NULL,
  expires_at BIGINT       NOT NULL,
  PRIMARY KEY (token),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `meta` (
  `key`   VARCHAR(64) NOT NULL,
  value   TEXT        NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 4. 自检：应当看到 5 张表 ----------
SHOW TABLES;
