# 把「计算机社交流论坛」注册成开机自启的计划任务（推荐长期使用）
#
# 用法（管理员 PowerShell 或普通 PowerShell 均可，任务以当前用户身份运行）：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# 卸载：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
#
# 效果：登录 Windows 后自动在后台启动论坛服务，崩溃后自动重启；
#       不再依赖任何 DSH / 会话窗口，关掉本对话也不影响群友访问。
# 注意：服务数据存在 MySQL 里，MySQL 的连接参数要放在【系统环境变量】中
#       （FORUM_MYSQL_HOST / USER / PASSWORD / DATABASE），否则计划任务里读不到。
#       服务器的正式部署请直接用 deploy\setup-server.ps1，它会写好这些配置。

param(
  [switch]$Uninstall,
  [string]$TaskName = '计算机社交流论坛',
  [int]$Port = 8210
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已卸载计划任务：$TaskName" -ForegroundColor Green
  } else {
    Write-Host "计划任务不存在：$TaskName"
  }
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$logs = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument 'server.mjs' `
  -WorkingDirectory $dir

# 崩溃/退出后 1 分钟内自动重启，最多 999 次
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# 当前用户登录后启动
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description '计算机社交流论坛：内网 200 人论坛服务（数据存 MySQL）' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -ExpandProperty IPAddress

Write-Host "已注册并启动计划任务：$TaskName" -ForegroundColor Green
Write-Host "  程序：$node server.mjs"
Write-Host "  目录：$dir"
Write-Host "  日志：$logs\forum.log（启动脚本需自行设置 FORUM_LOG，计划任务默认输出到任务历史）"
Write-Host "  本机：http://127.0.0.1:$Port"
foreach ($ip in $ips) { Write-Host "  校园网：http://$ip`:$Port" }
Write-Host ''
Write-Host '提示：如需访问口令，请先在系统环境变量中设置 FORUM_ACCESS_CODE 再启动任务。'
