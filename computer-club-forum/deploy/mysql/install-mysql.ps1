# ============================================================
#  计算机社交流论坛 · 在阿里云 Windows Server 上一键安装 MySQL 8
#
#  用法（管理员 PowerShell，在服务器上执行）：
#    .\deploy\mysql\install-mysql.ps1 -RootPassword '你的root强口令'
#
#  做的事：下载 ZIP 版 MySQL -> 解压到 C:\mysql -> 初始化数据目录
#          -> 写 my.ini（utf8mb4）-> 注册 Windows 服务 MySQL80 并启动
#          -> 用 root 口令自检
#  说明：ZIP 版不写注册表、不改系统 PATH，卸载就是删目录 + 删服务，最干净。
#        想要图形化向导也可以在服务器上跑：mysql-8.0.28-winx64.msi（阿里云镜像有）。
# ============================================================

param(
  [Parameter(Mandatory = $true)][string]$RootPassword,
  [string]$InstallDir = 'C:\mysql',
  [string]$DataDir = 'C:\mysql\data',
  [string]$ServiceName = 'MySQL80',
  [int]$Port = 3306,
  [string]$Version = '8.0.28',
  [string]$MirrorBase = 'https://mirrors.aliyun.com/mysql/MySQL-8.0',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    [!!] $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "    [XX] $t" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die '请以管理员身份运行 PowerShell（右键 → 以管理员身份运行）' }
if ($RootPassword -match "['`"\\]") { Die 'root 口令不能包含引号或反斜杠（初始化脚本里会破坏引号）' }

# ---------- 0. 已经装过就不重复装 ----------
Step 0 '检查现有 MySQL'
$existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingSvc) {
  if (-not $Force) {
    Warn "$ServiceName 已存在（状态 $($existingSvc.Status)），不重复安装。"
    Write-Host '    想重装请先：Stop-Service MySQL80 ; sc.exe delete MySQL80，并删除 C:\mysql 后重跑，或加 -Force'
    exit 0
  }
  Warn "按 -Force 要求：先停止并删除旧服务 $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
Ok '没有正在运行的旧实例'

# ---------- 1. 下载 ----------
Step 1 "下载 MySQL $Version（阿里云镜像）"
$zip = Join-Path $env:TEMP "mysql-$Version-winx64.zip"
$extractRoot = Join-Path $env:TEMP "mysql-$Version-extract"
if ((Test-Path $zip) -and (-not $Force)) {
  Ok "已有安装包：$zip"
} else {
  $urls = @(
    "$MirrorBase/mysql-$Version-winx64.zip",
    "https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-$Version-winx64.zip"
  )
  $done = $false
  foreach ($u in $urls) {
    try {
      Write-Host "    下载 $u"
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 1800
      $done = $true
      break
    } catch { Warn "失败，换下一个源：$($_.Exception.Message)" }
  }
  if (-not $done) { Die "下载失败。可手工下载 mysql-$Version-winx64.zip 放到 $zip 后重跑" }
  Ok "已下载 $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB"
}

# ---------- 2. 解压 ----------
Step 2 "解压到 $InstallDir"
if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extractRoot -Force
$inner = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
if (-not $inner) { Die '解压后找不到目录' }
if (Test-Path $InstallDir) {
  if (-not $Force) { Die "$InstallDir 已存在。确认要覆盖请加 -Force（会保留 data 目录）" }
  Warn "$InstallDir 已存在，保留其中的 data 目录并覆盖程序文件"
  Get-ChildItem $InstallDir -Exclude 'data' | Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $inner.FullName '*') -Destination $InstallDir -Recurse -Force
Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
$mysqld = Join-Path $InstallDir 'bin\mysqld.exe'
$mysql  = Join-Path $InstallDir 'bin\mysql.exe'
if (-not (Test-Path $mysqld)) { Die "缺少 $mysqld，安装包结构异常" }
Ok "$(& $mysqld --version)"

# ---------- 3. 初始化数据目录 ----------
Step 3 "初始化数据目录 $DataDir"
if (Test-Path (Join-Path $DataDir 'mysql')) {
  Warn '数据目录已存在，跳过初始化（要全新初始化请先备份并删除该目录）'
} else {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  & $mysqld "--basedir=$InstallDir" "--datadir=$DataDir" --initialize-insecure --console
  if ($LASTEXITCODE -ne 0) { Die "初始化失败（退出码 $LASTEXITCODE）" }
  Ok '初始化完成（root 初始为空口令，下一步立刻设置）'
}

# ---------- 4. 写 my.ini ----------
Step 4 '写入 my.ini（utf8mb4 + InnoDB）'
$ini = Join-Path $InstallDir 'my.ini'
$iniText = @"
[mysqld]
basedir=$($InstallDir -replace '\\','/')
datadir=$($DataDir -replace '\\','/')
port=$Port
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
default-storage-engine=InnoDB
max_connections=100
skip-name-resolve
log-error=$($DataDir -replace '\\','/')/mysql-error.log

[client]
default-character-set=utf8mb4
port=$Port

[mysql]
default-character-set=utf8mb4
"@
$iniText | Set-Content -Path $ini -Encoding ASCII
Ok $ini

# ---------- 5. 注册服务并启动 ----------
Step 5 "注册 Windows 服务 $ServiceName 并启动"
& sc.exe create $ServiceName binPath= "`"$mysqld`" --defaults-file=`"$ini`" $ServiceName" start= auto DisplayName= "MySQL Server $Version" | Out-Null
if ($LASTEXITCODE -ne 0) { Warn 'sc create 返回非零（服务可能已存在），继续尝试启动' }
& sc.exe description $ServiceName 'MySQL 8 数据库服务（计算机社交流论坛）' | Out-Null
Start-Service -Name $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service -Name $ServiceName
if ($svc.Status -ne 'Running') { Die "服务未启动（状态 $($svc.Status)），请看 $DataDir\mysql-error.log" }
Ok "服务运行中：$ServiceName"

# ---------- 6. 设置 root 口令 ----------
Step 6 '设置 root 口令'
$initSql = Join-Path $env:TEMP 'mysql-init-root.sql'
@"
ALTER USER 'root'@'localhost' IDENTIFIED BY '$RootPassword';
FLUSH PRIVILEGES;
"@ | Set-Content -Path $initSql -Encoding ASCII
& $mysql --host=127.0.0.1 --port=$Port --user=root --skip-password --execute="source $($initSql -replace '\\','/')"
$code = $LASTEXITCODE
Remove-Item $initSql -Force -ErrorAction SilentlyContinue
if ($code -ne 0) {
  Warn "用空口令连不上（可能已设置过口令）。如已知旧口令请手工执行："
  Warn "  & '$mysql' -u root -p -e `"ALTER USER 'root'@'localhost' IDENTIFIED BY '新口令';`""
} else {
  Ok 'root 口令已设置'
}

# ---------- 7. 自检 ----------
Step 7 '连接自检'
$env:MYSQL_PWD = $RootPassword
try {
  $ver = & $mysql --host=127.0.0.1 --port=$Port --user=root --batch --execute='SELECT VERSION();' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Die "用新口令连接失败：$ver" }
  Ok "连接成功：$($ver.Trim())"
} finally {
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '================ MySQL 安装完成 ================' -ForegroundColor Green
Write-Host "  程序目录  $InstallDir"
Write-Host "  数据目录  $DataDir"
Write-Host "  配置文件  $ini"
Write-Host "  服务名    $ServiceName（已设为自动启动）"
Write-Host "  端口      $Port"
Write-Host "  root 口令 $RootPassword"
Write-Host ''
Write-Host '  下一步（建库建表 + 创建应用账号）：'
Write-Host "    .\deploy\mysql\setup-mysql.ps1 -RootPassword '$RootPassword'"
Write-Host ''
Write-Host '  建议：不要修改「Windows 防火墙」为 3306 放行公网；只让本机/VPC 内网访问。'
Write-Host '===============================================' -ForegroundColor Green
