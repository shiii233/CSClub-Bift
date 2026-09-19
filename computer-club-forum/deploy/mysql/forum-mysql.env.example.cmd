REM ============================================================
REM  Computer Club Forum - MySQL connection settings (EXAMPLE FILE)
REM  Copy this file to forum.mysql.env.cmd and edit the values.
REM  After changing: schtasks /End /TN ComputerClubForum ^& schtasks /Run /TN ComputerClubForum
REM  NOTE: keep this file ASCII-only - it is loaded by cmd.exe, and a
REM        non-ASCII codepage would corrupt the values.
REM ============================================================

REM Storage backend: mysql (server deployment) / sqlite / json (local debug)
set FORUM_STORE=mysql

REM MySQL address: 127.0.0.1 when MySQL runs on this machine,
REM otherwise the PRIVATE endpoint of your RDS instance.
set FORUM_MYSQL_HOST=127.0.0.1
set FORUM_MYSQL_PORT=3306
set FORUM_MYSQL_USER=forum_app
set FORUM_MYSQL_PASSWORD=ChangeMe_Forum_2026

REM Must match the database created by 01-schema.sql
set FORUM_MYSQL_DATABASE=forum

REM Only needed when several forums share one database, e.g. club_
set FORUM_MYSQL_TABLE_PREFIX=

REM Enable TLS for Aliyun RDS (usually not needed for local MySQL)
REM set FORUM_MYSQL_SSL=1
REM set FORUM_MYSQL_SSL_CA=C:\forum\certs\rds-ca.pem

REM Connection pool size (default 4)
REM set FORUM_MYSQL_POOL_SIZE=4
