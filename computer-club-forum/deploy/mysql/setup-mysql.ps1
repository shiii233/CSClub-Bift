# ============================================================
#  计算机社交流论坛 · MySQL 初始化脚本（阿里云 ECS 自装 MySQL 或阿里云 RDS 都适用）
#
#  用法（管理员 PowerShell）：
#    .\deploy\mysql\setup-mysql.ps1 -RootPassword '你的root口令'
#    .\deploy\mysql\setup-mysql.ps1 -RootPassword 'root口令' -AppPassword 'forum强口令'
#    # 用 RDS：把内网地址填进 -DbHost
#    .\deploy\mysql\setup-mysql.ps1 -DbHost 'rm-xxxx.mysql.rds.aliyuncs.com' -RootUser 'rds_root' -RootPassword '...' -AppHost '%'
#
#  做的事：找 mysql.exe -> 测连通 -> 建库 -> 建 forum_app 账号并授权 -> 建表 -> 自检
#  幂等：库/表/账号都带 IF NOT EXISTS，重复执行不报错、不删数据。
# ============================================================

param(
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 3306,
  [string]$RootUser = 'root',
  [Parameter(Mandatory = $true)][string]$RootPassword,
  [string]$Database = 'forum',
  [string]$AppUser = 'forum_app',
  [string]$AppPassword = '',
  [string]$AppHost = 'localhost',
  [string]$MySqlExe = '',
  [string]$ExportEnvLines = '',
  [switch]$SkipUserCreation
)

$ErrorActionPreference = 'Stop'

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    [!!] $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "    [XX] $t" -ForegroundColor Red; exit 1 }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$schemaFile = Join-Path $scriptDir '01-schema.sql'
if (-not (Test-Path $schemaFile)) { Die "找不到建表脚本：$schemaFile" }

if (-not $AppPassword) {
  $AppPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Warn "未指定应用账号口令，已自动生成：$AppPassword"
}
if ($AppPassword -match "['`"\\]") { Die '应用口令不能包含引号或反斜杠（会破坏 SQL 引号），请换一个' }

# ---------- 1. 找 mysql.exe ----------
Step 1 '查找 mysql 客户端'
if ($MySqlExe -and (Test-Path $MySqlExe)) {
  Ok "使用指定路径：$MySqlExe"
} else {
  $cmd = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    $MySqlExe = $cmd.Source
  } else {
    $candidates = @(
      'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe',
      'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe',
      'C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe',
      'C:\Program Files\MariaDB 10.11\bin\mysql.exe',
      'C:\ProgramData\MySQL\MySQL Server 8.0\bin\mysql.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $MySqlExe = $c; break } }
  }
  if (-not $MySqlExe) {
    Die @"
找不到 mysql.exe。请先按《deploy/mysql/README-阿里云MySQL.md》装好 MySQL Server，
或手工执行建库脚本：mysql -u root -p < "$schemaFile"
装好后重跑本脚本，或用 -MySqlExe 'C:\...\bin\mysql.exe' 指定路径。
"@
  }
  Ok "mysql 客户端：$MySqlExe"
}

function Invoke-Mysql {
  param([string]$Sql, [string]$User, [string]$Password, [string]$Db = '')
  $args = @("--host=$DbHost", "--port=$Port", "--user=$User", '--default-character-set=utf8mb4')
  if ($Db) { $args += $Db }
  $args += '--batch'
  $env:MYSQL_PWD = $Password
  try {
    return ($Sql | & $MySqlExe @args 2>&1 | Out-String)
  } finally {
    Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  }
}

# ---------- 2. 连通性 ----------
Step 2 "测试 MySQL 连通性 $DbHost`:$Port"
try {
  $ver = Invoke-Mysql -Sql 'SELECT VERSION();' -User $RootUser -Password $RootPassword
  if ($LASTEXITCODE -ne 0) { Die "连接失败（退出码 $LASTEXITCODE）：`n$ver" }
  Ok "连接成功：$($ver.Trim())"
} catch {
  Die "无法连接 MySQL：$($_.Exception.Message)`n    请确认：MySQL 服务已启动 / 防火墙放行 $Port / root 口令正确"
}

# ---------- 3. 建库 + 建账号 ----------
Step 3 "创建数据库 $Database 与应用账号 $AppUser"
$sql = @"
CREATE DATABASE IF NOT EXISTS ``$Database``
  DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;
"@
if (-not $SkipUserCreation) {
  $sql += @"

CREATE USER IF NOT EXISTS '$AppUser'@'$AppHost' IDENTIFIED BY '$AppPassword';
ALTER USER '$AppUser'@'$AppHost' IDENTIFIED BY '$AppPassword';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, DROP
  ON ``$Database``.* TO '$AppUser'@'$AppHost';
FLUSH PRIVILEGES;
"@
}
$out = Invoke-Mysql -Sql $sql -User $RootUser -Password $RootPassword
if ($LASTEXITCODE -ne 0) { Die "建库/建账号失败：`n$out" }
Ok "库与账号就绪（账号来源 $AppHost）"

# ---------- 4. 建表 ----------
Step 4 '执行建表脚本 01-schema.sql'
$schemaSql = Get-Content $schemaFile -Raw -Encoding UTF8
# 脚本里自带的示例账号口令与本脚本参数可能不一致，这里统一改成参数值
$schemaSql = $schemaSql -replace "IDENTIFIED BY 'ChangeMe_Forum_2026'", "IDENTIFIED BY '$AppPassword'"
$schemaSql = $schemaSql -replace "forum_app", $AppUser
$schemaSql = $schemaSql -replace "CREATE USER IF NOT EXISTS '$AppUser'@'localhost'", "CREATE USER IF NOT EXISTS '$AppUser'@'$AppHost'"
$schemaSql = $schemaSql -replace "CREATE USER IF NOT EXISTS '$AppUser'@'127.0.0.1'", "CREATE USER IF NOT EXISTS '$AppUser'@'$AppHost'"
$schemaSql = $schemaSql -replace "TO '$AppUser'@'localhost'", "TO '$AppUser'@'$AppHost'"
$schemaSql = $schemaSql -replace "TO '$AppUser'@'127.0.0.1'", "TO '$AppUser'@'$AppHost'"
$schemaSql = $schemaSql -replace 'CREATE DATABASE IF NOT EXISTS `forum`', "CREATE DATABASE IF NOT EXISTS ``$Database``"
$schemaSql = $schemaSql -replace '(?m)^USE `forum`;', "USE ``$Database``;"
$out = Invoke-Mysql -Sql $schemaSql -User $RootUser -Password $RootPassword
if ($LASTEXITCODE -ne 0) { Die "建表失败：`n$out" }
$tables = ($out -split "`n" | Where-Object { $_ -match '^(users|posts|replies|sessions|meta)$' }).Count
Ok "建表完成，检测到 $tables 张表"

# ---------- 5. 用应用账号自检 ----------
Step 5 "用应用账号 $AppUser 连接自检"
try {
  $check = Invoke-Mysql -Sql 'SELECT COUNT(*) AS users FROM users; SHOW TABLES;' -User $AppUser -Password $AppPassword -Db $Database
  if ($LASTEXITCODE -ne 0) { Die "应用账号连不上：`n$check" }
  Ok "应用账号可用，库内表：`n$check"
} catch {
  Die "应用账号自检失败：$($_.Exception.Message)"
}

# ---------- 完成 ----------
if ($ExportEnvLines) {
  # 供 setup-server.ps1 之类的自动化脚本取用：把配置行写进指定文件
  $envLines = @(
    'set FORUM_STORE=mysql',
    "set FORUM_MYSQL_HOST=$DbHost",
    "set FORUM_MYSQL_PORT=$Port",
    "set FORUM_MYSQL_USER=$AppUser",
    "set FORUM_MYSQL_PASSWORD=$AppPassword",
    "set FORUM_MYSQL_DATABASE=$Database"
  )
  $envLines -join "`r`n" | Set-Content -Path $ExportEnvLines -Encoding OEM
  Ok "连接参数已写入：$ExportEnvLines"
}

Write-Host ''
Write-Host '================ MySQL 初始化完成 ================' -ForegroundColor Green
Write-Host "  地址      $DbHost`:$Port"
Write-Host "  库名      $Database"
Write-Host "  应用账号  $AppUser"
Write-Host "  应用口令  $AppPassword"
Write-Host ''
Write-Host '  下一步：把下面几行写进 C:\forum\forum.env.cmd（或 deploy\mysql\forum-mysql.env.example.cmd 复制过去改）'
Write-Host '  ------------------------------------------------------------'
Write-Host '  set FORUM_STORE=mysql'
Write-Host "  set FORUM_MYSQL_HOST=$DbHost"
Write-Host "  set FORUM_MYSQL_PORT=$Port"
Write-Host "  set FORUM_MYSQL_USER=$AppUser"
Write-Host "  set FORUM_MYSQL_PASSWORD=$AppPassword"
Write-Host "  set FORUM_MYSQL_DATABASE=$Database"
Write-Host '  ------------------------------------------------------------'
Write-Host '  然后重启服务：schtasks /End /TN ComputerClubForum ; schtasks /Run /TN ComputerClubForum'
Write-Host '  迁数据：cd /d C:\forum\app ; node ops.mjs migrate'
Write-Host '=================================================' -ForegroundColor Green
