# ============================================================
#  计算机社交流论坛 - 阿里云 Windows Server 一键部署脚本（MySQL 版）
#  用法（服务器上以管理员身份运行 PowerShell）：
#      cd C:\forum-installer ; .\deploy\setup-server.ps1
#  没装 MySQL 时先跑：
#      .\deploy\mysql\install-mysql.ps1 -RootPassword 'root强口令'
#  再跑本脚本（可把 root 口令传进来自动建库建账号）：
#      .\deploy\setup-server.ps1 -MySqlRootPassword 'root强口令'
#  脚本内容：便携版 Node -> 建目录 -> 初始化 MySQL/建库建表 -> 迁移历史数据
#            -> 自签证书 -> 启动服务 -> 开机自启计划任务 -> 防火墙 -> 自检 -> 每日备份
# ============================================================

param(
  [int]$Port = 8443,
  [string]$InstallDir = 'C:\forum',
  [string]$AccessCode = '',
  # 证书里的服务器名：填这台服务器的【内网 IP】或内网域名。
  # 留空则自动取本机第一个非回环 IPv4 地址；因为是自签证书，填不填浏览器都会提示不受信任。
  [string]$ServerAddress = '',
  [ValidateSet('mysql', 'sqlite')][string]$Store = 'mysql',
  [string]$MySqlHost = '127.0.0.1',
  [int]$MySqlPort = 3306,
  [string]$MySqlDatabase = 'forum',
  [string]$MySqlUser = 'forum_app',
  [string]$MySqlPassword = '',
  [string]$MySqlRootPassword = '',
  [string]$MySqlRootUser = 'root',
  [string]$MySqlInstallDir = 'C:\mysql',
  [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    [!!] $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "    [XX] $t" -ForegroundColor Red; exit 1 }

# 把文本按 ASCII 写文件（UTF-16 的 .cmd 会让 cmd 解析乱码）
function Write-AsciiFile($Path, $Text) {
  $dir = Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.ASCIIEncoding]::new())
}

# 读取 forum.env.cmd 里的 set KEY=VALUE，写进当前进程环境变量
function Import-ForumEnv($Path) {
  if (-not (Test-Path $Path)) { return }
  foreach ($line in (Get-Content $Path -Encoding ASCII)) {
    if ($line -match '^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), 'Process')
    }
  }
}

# ---------- 0. 环境检查 ----------
Step 0 '环境检查'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die '请以管理员身份运行 PowerShell 后再执行本脚本' }
Ok "管理员权限 OK，系统 $([Environment]::OSVersion.VersionString)，PowerShell $($PSVersionTable.PSVersion)"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcRoot = Split-Path -Parent $scriptDir
if (-not (Test-Path (Join-Path $srcRoot 'server.mjs'))) { Die "找不到 server.mjs，请确认项目文件已解压到 $srcRoot" }
Ok "项目文件：$srcRoot"

if (-not $AccessCode) {
  $AccessCode = -join ((48..57) + (97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
  Warn "未指定访问口令，已自动生成：$AccessCode"
}

# 证书/提示里用的服务器名：优先用参数，其次取本机第一个非回环 IPv4
if (-not $ServerAddress) {
  $probe = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
  if ($probe) { $ServerAddress = $probe.IPAddress } else { $ServerAddress = '127.0.0.1' }
  Warn "未指定 -ServerAddress，已按本机网卡推断为 $ServerAddress（要精确指定请加该参数）"
}

# ---------- 1. 目录 ----------
Step 1 '创建目录结构'
foreach ($d in @($InstallDir, "$InstallDir\app", "$InstallDir\data", "$InstallDir\logs", "$InstallDir\backups", "$InstallDir\certs", "$InstallDir\runtime")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Ok "$InstallDir 下的 app / data / logs / backups / certs / runtime"

# ---------- 2. 停止已有实例 ----------
Step 2 '检查并停止已有实例'
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  foreach ($c in $existing) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Ok "已停止占用 $Port 的旧进程"
} else {
  Ok "端口 $Port 空闲"
}

# ---------- 3. 便携版 Node ----------
Step 3 '准备 Node 运行时（便携版，不改系统环境变量）'
$nodeDir = Join-Path $InstallDir 'runtime\node'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (Test-Path $nodeExe) {
  Ok "已存在：$(& $nodeExe --version)"
} else {
  $zip = Join-Path $env:TEMP 'node-forum.zip'
  $urls = @(
    'https://npmmirror.com/mirrors/node/v24.9.0/node-v24.9.0-win-x64.zip',
    'https://nodejs.org/dist/v24.9.0/node-v24.9.0-win-x64.zip'
  )
  $done = $false
  foreach ($u in $urls) {
    try {
      Write-Host "    下载 $u"
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 600
      $done = $true
      break
    } catch { Warn "下载失败，换下一个源：$($_.Exception.Message)" }
  }
  if (-not $done) { Die 'Node 下载失败：请手动下载 node-v24-win-x64.zip 解压到 runtime\node 后重跑' }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $InstallDir 'runtime') -Force
  $extracted = Get-ChildItem (Join-Path $InstallDir 'runtime') -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
  if (-not $extracted) { Die '解压后找不到 node 目录' }
  if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
  Move-Item $extracted.FullName $nodeDir
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Ok "已安装 $(& $nodeExe --version)"
}

# ---------- 4. 应用代码 ----------
Step 4 '复制应用代码'
$appDir = Join-Path $InstallDir 'app'
foreach ($item in @('server.mjs', 'ops.mjs', 'public', 'src', 'package.json', 'package-lock.json')) {
  $s = Join-Path $srcRoot $item
  if (Test-Path $s) { Copy-Item $s -Destination $appDir -Recurse -Force } else { Warn "缺少 $item" }
}
Ok "代码已就位：$appDir"

# ---------- 5. MySQL：安装 / 建库建表 / 装驱动 ----------
$mysqlEnvFile = Join-Path $InstallDir 'forum.mysql.env.cmd'
if ($Store -eq 'mysql') {
  Step 5 "准备 MySQL（$MySqlHost`:$MySqlPort/$MySqlDatabase）"

  # 5.1 本机没装 MySQL 就先装
  $mysqlSvc = Get-Service -Name 'MySQL80' -ErrorAction SilentlyContinue
  if (-not $mysqlSvc -and ($MySqlHost -eq '127.0.0.1' -or $MySqlHost -eq 'localhost')) {
    if ($MySqlRootPassword) {
      Warn '本机没检测到 MySQL80 服务，先调用 install-mysql.ps1 安装'
      & powershell -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'mysql\install-mysql.ps1') `
        -RootPassword $MySqlRootPassword -InstallDir $MySqlInstallDir -Port $MySqlPort
      if ($LASTEXITCODE -ne 0) { Die 'MySQL 安装失败，请先手工装好 MySQL 再重跑本脚本' }
      Ok 'MySQL 已安装'
    } else {
      Die @"
本机没有 MySQL，且没有提供 -MySqlRootPassword，无法自动安装。
请先执行下面任意一条，然后重跑本脚本：
  A) 自动安装： .\deploy\mysql\install-mysql.ps1 -RootPassword '你的root口令'
  B) 用 RDS  ： .\deploy\setup-server.ps1 -MySqlHost 'rm-xxx.mysql.rds.aliyuncs.com' -MySqlUser forum_app -MySqlPassword '...'
"@
    }
  } else {
    Ok "检测到 MySQL 服务：$($mysqlSvc.Name)（$($mysqlSvc.Status)）"
  }

  # 5.2 建库 + 建应用账号 + 建表（脚本幂等，可重复执行）
  $setupMysql = Join-Path $scriptDir 'mysql\setup-mysql.ps1'
  if (-not (Test-Path $setupMysql)) { Die "找不到 $setupMysql" }
  $rootPwdForSetup = if ($MySqlRootPassword) { $MySqlRootPassword } else { $MySqlPassword }
  if (-not $rootPwdForSetup) { Die '需要 -MySqlRootPassword（建库用）或 -MySqlPassword（已有库时用它连接）' }
  $setupArgs = @{
    DbHost = $MySqlHost; Port = $MySqlPort; RootUser = $MySqlRootUser; RootPassword = $rootPwdForSetup
    Database = $MySqlDatabase; AppUser = $MySqlUser; ExportEnvLines = $mysqlEnvFile
  }
  if ($MySqlPassword) { $setupArgs.AppPassword = $MySqlPassword }
  if (-not $MySqlRootPassword) { $setupArgs.SkipUserCreation = $true }
  & powershell -ExecutionPolicy Bypass -File $setupMysql @setupArgs
  if ($LASTEXITCODE -ne 0) { Die 'MySQL 初始化失败，请按上面的提示处理后重跑' }
  Ok "数据库与账号就绪（连接参数已写入 $mysqlEnvFile）"

  # 5.3 安装 mysql2 驱动到一个「不带空格」的目录
  #     （npm 在处理含空格的路径时容易出问题，所以运行目录固定为 C:\forum\app）
  if (Test-Path (Join-Path $appDir 'node_modules\mysql2\package.json')) {
    Ok 'mysql2 驱动已存在，跳过安装'
  } else {
    $npmCmd = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
    if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm' }
    Write-Host '    安装 mysql2（约 12 个包，走阿里云 npm 镜像）'
    Push-Location $appDir
    try {
      & $npmCmd install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com 2>&1 | ForEach-Object { Write-Host "      $_" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path (Join-Path $appDir 'node_modules\mysql2\package.json'))) {
      Die "mysql2 安装失败。请在服务器上手工执行： cd $appDir ; npm install mysql2 --registry=https://registry.npmmirror.com"
    }
    Ok 'mysql2 驱动已安装'
  }
} else {
  Step 5 '按参数跳过 MySQL（-Store sqlite）：使用单文件 SQLite 数据库'
}

# ---------- 6. 迁移历史数据 ----------
Step 6 '迁移历史数据到数据库'
$legacy = Join-Path $InstallDir 'data\forum.json'
$dbFile = Join-Path $InstallDir 'data\forum.db'
$bundleLegacy = Join-Path $srcRoot 'data\forum.json'
if ((Test-Path $bundleLegacy) -and (-not (Test-Path $legacy))) { Copy-Item $bundleLegacy $legacy -Force }

if ($Store -eq 'mysql') {
  if (-not (Test-Path $legacy)) {
    Warn '没有找到历史数据 data\forum.json，从空论坛开始'
  } else {
    Import-ForumEnv $mysqlEnvFile
    $env:FORUM_STORE = 'mysql'
    $env:FORUM_DATA_FILE = $legacy
    Write-Host '    把 forum.json 导入 MySQL（库里已有用户则自动跳过）'
    Push-Location $appDir
    try {
      & $nodeExe ops.mjs migrate
      if ($LASTEXITCODE -ne 0) { Warn '迁移命令返回非零，请查看上面的输出' }
      else { Ok '迁移命令执行完成' }
      & $nodeExe ops.mjs status
    } finally {
      Pop-Location
    }
  }
} else {
  if (Test-Path $dbFile) {
    Ok 'SQLite 数据库已存在，跳过迁移'
  } elseif (Test-Path $legacy) {
    $env:FORUM_DB_FILE = $dbFile
    $env:FORUM_DATA_FILE = $legacy
    Push-Location $appDir
    & $nodeExe ops.mjs migrate --store sqlite
    Pop-Location
    Ok '迁移完成'
  } else {
    Warn '没有历史数据，从空论坛开始'
  }
}

# ---------- 6. 自签证书 ----------
Step 6 '生成自签 TLS 证书'
$certFile = Join-Path $InstallDir 'certs\cert.pem'
$keyFile = Join-Path $InstallDir 'certs\key.pem'
if ((Test-Path $certFile) -and (Test-Path $keyFile)) {
  Ok '证书已存在，跳过'
} else {
  $pfxPass = 'forum-tls'
  $pfx = Join-Path $InstallDir 'certs\tmp.pfx'
  $c = New-SelfSignedCertificate -DnsName @($ServerAddress, 'localhost') -CertStoreLocation 'Cert:\LocalMachine\My' -NotAfter (Get-Date).AddYears(5) -FriendlyName 'ForumSelfSigned'
  $sec = ConvertTo-SecureString -String $pfxPass -AsPlainText -Force
  Export-PfxCertificate -Cert $c -FilePath $pfx -Password $sec | Out-Null
  $derFile = Join-Path $InstallDir 'certs\tmp.cer'
  Export-Certificate -Cert $c -FilePath $derFile -Type CERT | Out-Null
  $convJs = Join-Path $env:TEMP 'pfx2pem.cjs'
  $convLines = @(
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    "const pfxPath = process.argv[2], pass = process.argv[3], derPath = process.argv[4], certOut = process.argv[5], keyOut = process.argv[6];",
    "const p12 = crypto.createPrivateKey({ key: fs.readFileSync(pfxPath), format: 'der', type: 'pkcs12', passphrase: pass });",
    "fs.writeFileSync(keyOut, p12.export({ type: 'pkcs8', format: 'pem' }));",
    "const b64 = fs.readFileSync(derPath).toString('base64').replace(/(.{64})/g, '$1\n');",
    "fs.writeFileSync(certOut, '-----BEGIN CERTIFICATE-----\n' + b64 + '-----END CERTIFICATE-----\n');"
  )
  $convLines -join "`r`n" | Set-Content -Path $convJs -Encoding UTF8
  & $nodeExe $convJs $pfx $pfxPass $derFile $certFile $keyFile
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
    Warn '证书生成失败，将先用 HTTP 运行（可稍后补证书）'
    $certFile = ''
    $keyFile = ''
  } else {
    Remove-Item $pfx, $derFile -Force -ErrorAction SilentlyContinue
    Ok "证书已生成：$certFile"
  }
}

# ---------- 7. 配置与启动脚本 ----------
Step 7 '写入配置与启动脚本'
$configFile = Join-Path $InstallDir 'forum.env.cmd'
$cfg = @(
  '@echo off',
  'rem 计算机社交流论坛运行参数（改完需重启计划任务 ComputerClubForum）',
  "set FORUM_STORE=$Store",
  "set FORUM_DATA_FILE=$InstallDir\data\forum.json",
  "set FORUM_DB_FILE=$InstallDir\data\forum.db",
  "set PORT=$Port",
  'set FORUM_HOST=0.0.0.0',
  'set FORUM_ALLOW_CIDRS=',
  "set FORUM_ACCESS_CODE=$AccessCode",
  "set FORUM_LOG=$InstallDir\logs\forum.log"
)
if ($Store -eq 'mysql' -and (Test-Path $mysqlEnvFile)) {
  $cfg += 'call "%~dp0forum.mysql.env.cmd"'
} elseif ($Store -eq 'mysql') {
  $cfg += 'set FORUM_MYSQL_HOST=127.0.0.1'
  $cfg += "set FORUM_MYSQL_PORT=$MySqlPort"
  $cfg += "set FORUM_MYSQL_USER=$MySqlUser"
  $cfg += "set FORUM_MYSQL_PASSWORD=$MySqlPassword"
  $cfg += "set FORUM_MYSQL_DATABASE=$MySqlDatabase"
}
if ($certFile -and (Test-Path $certFile)) {
  $cfg += "set FORUM_TLS_CERT=$certFile"
  $cfg += "set FORUM_TLS_KEY=$keyFile"
}
Write-AsciiFile $configFile ($cfg -join "`r`n")

$runFile = Join-Path $InstallDir 'run-forum.cmd'
$runLines = @(
  '@echo off',
  'chcp 65001 >nul',
  "cd /d $appDir",
  "call `"$configFile`"",
  "`"$nodeExe`" server.mjs >> `"$InstallDir\logs\server-stdout.log`" 2>&1"
)
$runLines -join "`r`n" | Set-Content -Path $runFile -Encoding OEM
Ok "$configFile"
Ok "$runFile"

# ---------- 8. 开机自启计划任务 ----------
Step 8 '注册计划任务（开机自启 + 崩溃自动重启）'
$taskName = 'ComputerClubForum'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runFile`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '计算机社交流论坛服务' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Ok "计划任务已注册并启动：$taskName"

# ---------- 9. 防火墙 ----------
if (-not $NoFirewall) {
  Step 9 "防火墙放行 TCP $Port"
  Get-NetFirewallRule -DisplayName 'Forum-HTTPS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'Forum-HTTPS' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Ok "已放行（阿里云安全组仍需放行 $Port）"
} else {
  Step 9 '按参数跳过防火墙配置'
}

# ---------- 10. 自检 ----------
Step 10 '启动自检'
$up = $false
$health = $null
for ($i = 1; $i -le 25; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($health.ok) { $up = $true; break }
  } catch { }
}
if (-not $up) {
  Warn '健康检查未通过，最近日志：'
  if (Test-Path "$InstallDir\logs\forum.log") { Get-Content "$InstallDir\logs\forum.log" -Tail 30 }
  if (Test-Path "$InstallDir\logs\server-stdout.log") { Get-Content "$InstallDir\logs\server-stdout.log" -Tail 30 }
  Die '服务未起来，请把上面的日志发我'
}
Ok "服务在线：$($health | ConvertTo-Json -Compress)"
if ($Store -eq 'mysql') {
  if ($health.dbOk) { Ok "数据库连通：MySQL $($health.dbVersion) @ $($health.db)（账号 $($health.dbUser)）" }
  else { Die "服务起来了，但数据库探活失败：$($health.dbError)" }
}

# ---------- 11. 每日备份 ----------
Step 11 '注册每日备份任务'
$backupScript = Join-Path $InstallDir 'backup-forum.cmd'
$bkLines = @(
  '@echo off',
  'chcp 65001 >nul',
  "cd /d $appDir",
  "call `"$configFile`"",
  "`"$nodeExe`" ops.mjs backup `"$InstallDir\backups`" >> `"$InstallDir\logs\backup.log`" 2>&1"
)
$bkLines -join "`r`n" | Set-Content -Path $backupScript -Encoding OEM
$bt = 'ComputerClubForumBackup'
if (Get-ScheduledTask -TaskName $bt -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $bt -Confirm:$false }
$a2 = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$backupScript`"" -WorkingDirectory $InstallDir
$t2 = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName $bt -Action $a2 -Trigger $t2 -Principal $principal -Description '论坛每日备份' -Force | Out-Null
Ok '每日 03:00 自动备份到 backups\（保留最近 7 份）'

# ---------- 完成 ----------
$scheme = 'http'
if ($certFile -and (Test-Path $certFile)) { $scheme = 'https' }
Write-Host ''
Write-Host '================ 部署完成 ================' -ForegroundColor Green
Write-Host "  本机访问    ${scheme}://127.0.0.1:$Port/?code=$AccessCode"
Write-Host "  内网访问    ${scheme}://${ServerAddress}:$Port/?code=$AccessCode"
Write-Host "  访问口令    $AccessCode"
if ($Store -eq 'mysql') {
  Write-Host "  数据存储    MySQL $MySqlHost`:$MySqlPort / 库 $MySqlDatabase / 账号 $MySqlUser"
  Write-Host "  连接参数    $configFile + $mysqlEnvFile"
} else {
  Write-Host "  数据存储    SQLite（$InstallDir\data\forum.db）"
}
Write-Host "  日志目录    $InstallDir\logs"
Write-Host "  计划任务    $taskName / $bt"
Write-Host ''
Write-Host '  待办：'
Write-Host "   1) 阿里云安全组入方向放行 TCP $Port"
Write-Host '   2) 访问口令私发给社员，不要贴到公开群里'
Write-Host '==========================================' -ForegroundColor Green
