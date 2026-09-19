# 阿里云服务器 · MySQL 部署手册（计算机社交流论坛）

面向：**阿里云 ECS（Windows Server）+ MySQL**，访问策略保持「只走内网/VPN，不对公网开放」。
本文解决「MySQL 从零怎么建」；论坛本身的部署见 `deploy/setup-server.ps1`。

---

## 0. 先选一条路

| 方案 | 适合 | 成本 | 要做的事 |
| --- | --- | --- | --- |
| **A. 在 ECS 上自装 MySQL** | 就一台机器、想省事省钱 | 只要 ECS 的钱 | 装 MySQL → 跑 `setup-mysql.ps1` |
| **B. 阿里云 RDS MySQL** | 想要自动备份/高可用、以后可能扩容 | 额外 RDS 费用 | 控制台建实例 → 内网地址填进 `setup-mysql.ps1` |

两种方案的论坛侧配置完全一样，只是 `FORUM_MYSQL_HOST` 填 `127.0.0.1` 还是 RDS 内网地址。

> **重要**：不管哪种方案，都**不要**在阿里云安全组放行 3306 给 `0.0.0.0/0`。
> 论坛服务和 MySQL 在同一台机器/同一 VPC 内，走内网就够了；3306 暴露公网等于把数据库交出去。

---

## 方案 A：在 ECS 上自装 MySQL 8

### A1. 装 MySQL（二选一：一键脚本 / 图形向导）

**方式一（推荐，全自动）**：用项目自带脚本装 ZIP 版，不写注册表、不改 PATH，卸载只要删目录 + 删服务。

```powershell
cd C:\forum-installer
.\deploy\mysql\install-mysql.ps1 -RootPassword '你自己定的root强口令'
```

脚本会：从阿里云镜像下载 `mysql-8.0.28-winx64.zip` → 解压到 `C:\mysql` → 初始化数据目录 →
写 `my.ini`（utf8mb4）→ 注册并启动 Windows 服务 `MySQL80` → 设置 root 口令 → 自检。

**方式二（图形向导）**：跑 MSI 安装包，按向导点。

```powershell
# 阿里云镜像（已验证可下载，135 MB）
Invoke-WebRequest -Uri 'https://mirrors.aliyun.com/mysql/MySQL-8.0/mysql-8.0.28-winx64.msi' `
  -OutFile "$env:TEMP\mysql-8.0.28-winx64.msi" -UseBasicParsing -TimeoutSec 1800
Start-Process msiexec.exe -ArgumentList "/i `"$env:TEMP\mysql-8.0.28-winx64.msi`"" -Wait
```

> 想要带「配置向导」的 MySQL Installer，去官网下：<https://dev.mysql.com/downloads/installer/>
> （阿里云镜像只有 Server 的 MSI/ZIP，没有 installer-community；镜像目录：<https://mirrors.aliyun.com/mysql/>）

MSI 方式装完后如果 `mysql.exe` 不在 PATH 里，跑初始化脚本时用 `-MySqlExe` 指定，例如：

```powershell
.\deploy\mysql\setup-mysql.ps1 -RootPassword '你的root口令' -MySqlExe 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
```

### A2. 用图形向导的话，照抄这些选项

1. Choosing a Setup Type → **Server only**
2. Type and Networking →
   - Config Type: **Development Computer**
   - Port: **3306**
   - ✅ TCP/IP（Windows 防火墙那项开不开都行，开了也只在内网）
3. Authentication Method → **Use Strong Password Encryption**（推荐）
4. Accounts and Roles → 设置 **root 口令**，**务必记下来**（后面 `-RootPassword` 要用）
5. Windows Service → ✅ Configure MySQL Server as a Windows Service，服务名 `MySQL80`，✅ Start at System Startup
6. Apply Configuration → Execute → Finish

装完确认服务在跑：

```powershell
Get-Service MySQL80 | Select-Object Name, Status, StartType
```

### A3. 给防火墙定个规矩（可选但建议）

只为内网放行 3306，公网不放（若原本被 Installer 放开成任意来源，改成私网）：

```powershell
Get-NetFirewallRule -DisplayName 'MySQL80' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'MySQL80-内网' -Direction Inbound -Protocol TCP -LocalPort 3306 `
  -Action Allow -Profile Private,Domain | Out-Null
```

### A4. 建库 + 建账号 + 建表（一条命令）

```powershell
cd C:\forum-installer            # 项目解压目录（含 deploy\mysql\）
.\deploy\mysql\setup-mysql.ps1 -RootPassword '第 A2 步的 root 口令'
```

脚本会自动：找 `mysql.exe` → 测连通 → 建 `forum` 库 → 建 `forum_app` 账号并授权 → 建 5 张表 → 用应用账号自检，
最后把要写进 `forum.env.cmd` 的 6 行配置打印出来（**应用口令请一并记下**）。

想指定自己的口令：`-AppPassword '你自己定的强口令'`。

---

## 方案 B：阿里云 RDS MySQL

### B1. 控制台建实例

1. 阿里云控制台 → **云数据库 RDS** → 创建实例
   - 引擎：**MySQL 8.0**
   - 系列：**基础版**（社团够用）或高可用版
   - 网络：**专有网络 VPC**，选择与 ECS **同一个 VPC、同一个交换机**（这样才能内网互通且不暴露公网）
2. 实例创建后，在「数据库连接」里记下 **内网地址**（形如 `rm-xxxxxx.mysql.rds.aliyuncs.com`）和端口 `3306`
3. 「账号管理」→ 创建账号：账号名 `forum_app`，类型选 **普通账号**，设置口令
4. 「数据库管理」→ 创建数据库：库名 `forum`，字符集 **utf8mb4**
5. 「白名单」→ 把 ECS 的**内网 IP** 加进去（不要填 `0.0.0.0/0`）

> RDS 的默认高权限账号是 `rds_root` 之类；用普通账号 `forum_app` 就够了，
> 库创建好之后下面的 `setup-mysql.ps1` 只需要「建表」权限。

### B2. 建表 + 自检（在 ECS 上执行）

```powershell
cd C:\forum-installer
.\deploy\mysql\setup-mysql.ps1 `
  -DbHost 'rm-xxxxxx.mysql.rds.aliyuncs.com' `
  -RootUser 'forum_app' -RootPassword '你设的账号口令' `
  -Database 'forum' -AppUser 'forum_app' -AppPassword '你设的账号口令' `
  -SkipUserCreation          # 账号已在控制台建好，跳过 CREATE USER
```

### B3. RDS 建议开启 TLS

```cmd
set FORUM_MYSQL_SSL=1
set FORUM_MYSQL_SSL_CA=C:\forum\certs\rds-ca.pem
```

CA 证书在 RDS 控制台「数据安全性 → SSL」里下载。

---

## 3. 把连接参数交给论坛

`setup-server.ps1` 会自动写好这些；手工维护时对应 `C:\forum\forum.env.cmd`：

```cmd
set FORUM_STORE=mysql
set FORUM_MYSQL_HOST=127.0.0.1        &:: RDS 就填内网地址
set FORUM_MYSQL_PORT=3306
set FORUM_MYSQL_USER=forum_app
set FORUM_MYSQL_PASSWORD=你的应用口令
set FORUM_MYSQL_DATABASE=forum
```

改完重启服务：

```powershell
schtasks /End /TN ComputerClubForum
schtasks /Run /TN ComputerClubForum
Invoke-RestMethod http://127.0.0.1:8443/healthz | ConvertTo-Json
```

`/healthz` 里出现 `"store":"mysql"`、`"dbOk":true`、`dbVersion` 就是通了。

---

## 4. 迁历史数据到 MySQL

现有 `data/forum.json` 会被自动迁移：**MySQL 里 users 表为空**且项目目录下存在 `data/forum.json` 时，
服务启动会自动导入并把原文件改名为 `forum.json.migrated` 留档。

想手工迁一次（推荐，能看到结果）：

```powershell
cd C:\forum\app
node ops.mjs migrate      # 幂等：库里已有用户就跳过
node ops.mjs status       # 看用户/帖子/回复/会话数量
node ops.mjs verify       # 校验作者与楼层自洽
```

> 迁进来的历史数据里有测试账号（`测试丙`、`压力1`~`压力5`），管理员在网页上
> `封禁用户测试丙` 或直接在库里删掉即可；整体清空用 `node server.mjs --clear`。

---

## 5. 日常运维

| 操作 | 命令 |
| --- | --- |
| 看状态 | `node ops.mjs status` |
| 体检 | `node ops.mjs verify` |
| 备份 | `node ops.mjs backup C:\forum\backups`（有 `mysqldump.exe` 导 SQL，没有则导数据快照 SQL，均保留最近 7 份） |
| 连库确认 | `node ops.mjs ping` |
| 看建表 SQL | `node ops.mjs schema` |
| 清空重开 | `node server.mjs --clear` |
| 清测试账号 | `node server.mjs --prune` |
| 数据库服务状态 | `Get-Service MySQL80` |
| 慢/报错日志 | `C:\ProgramData\MySQL\MySQL Server 8.0\Data\*.err` |

自动备份：`setup-server.ps1` 会注册每日 03:00 的计划任务 `ComputerClubForumBackup`，日志在 `C:\forum\logs\backup.log`。

RDS 方案则用控制台「备份恢复」设置自动备份策略，`ops.mjs backup` 作为额外补充。

---

## 6. 出问题怎么查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `连接 MySQL 失败 ... ECONNREFUSED` | MySQL 没启动 / 端口不对 | `Get-Service MySQL80`；`Test-NetConnection 127.0.0.1 -Port 3306` |
| 报 `ER_ACCESS_DENIED_ERROR` | 账号口令错，或账号来源主机受限 | 核对 `forum.env.cmd`；`setup-mysql.ps1` 重新生成账号 |
| 报 `ER_BAD_DB_ERROR: Unknown database 'forum'` | 库没建 | 跑 `deploy/mysql/01-schema.sql` |
| 报 `未安装 MySQL 驱动 mysql2` | `node_modules` 没装 | `cd C:\forum\app ; npm install mysql2 --registry=https://registry.npmmirror.com` |
| 中文变问号/乱码 | 库不是 utf8mb4 | 重建库时指定 `DEFAULT CHARSET=utf8mb4`，见 `01-schema.sql` |
| 页面能用但重启后掉线 | sessions 表没写进去 | `node ops.mjs status` 看会话数；检查 `forum_app` 是否有 `INSERT/DELETE` 权限 |
| `/healthz` 返回 503 | 数据库探活失败 | 响应体里的 `dbError` 直接给出原因 |
| 帖子越攒越多变慢 | 数据靠内存 + 事务全量重写 | 200 人规模足够；真到几万帖再考虑增量写入（README「设计取舍」） |

---

## 7. 安全清单（上线前逐条打勾）

- [ ] 阿里云安全组：3306 **不对公网开放**（只留内网）
- [ ] MySQL 账号用 `forum_app` 而非 `root`，权限只给 `forum` 库
- [ ] root 口令、`forum_app` 口令都是强口令，且不写进公开群聊
- [ ] `forum.env.cmd` 只放在服务器上，不要提交到代码仓库
- [ ] 每日备份任务已注册并验证能产出文件（`C:\forum\backups`）
- [ ] `FORUM_ACCESS_CODE` 已设置，且论坛只在内网/VPN 内可达
- [ ] RDS 方案：SSL 已开启（`FORUM_MYSQL_SSL=1`）
