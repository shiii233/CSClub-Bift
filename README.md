# 计算机社交流论坛（最多 200 人 · 阿里云部署 · MySQL）

社团内部论坛网页：独立用户身份、三个板块发帖、楼层回复、指令式操作，并可按指令输出纯文本论坛界面。
服务端部署在**阿里云服务器（Windows Server）**上，数据存放在 **MySQL**；
默认监听全部网卡但**只放行校园网/内网私有网段，公网来源一律拒绝**（配合安全组与 VPN 使用）。

**首次部署为空论坛，不含任何人物与内容。**

---

## 1. 服务器部署（三步）

在阿里云 ECS 上以**管理员 PowerShell** 执行。项目解压到 `C:\forum-installer`（路径带空格也没问题）。

```powershell
cd C:\forum-installer

# 第 1 步：装 MySQL（ZIP 版，装到 C:\mysql，注册服务 MySQL80）
.\deploy\mysql\install-mysql.ps1 -RootPassword '你自己的root强口令'

# 第 2 步：一键部署论坛（装 Node -> 建库建表 -> 装 mysql2 -> 装服务 -> 自启 -> 自检）
.\deploy\setup-server.ps1 -MySqlRootPassword '你自己的root强口令'

# 第 3 步：把访问口令私发给社员（脚本会打印，形如 xx7k2m9q4p）
```

部署脚本给出的地址形如 `https://<服务器内网IP>:8443/?code=<访问口令>`。

**已经装过 MySQL（或要连阿里云 RDS）时**，跳过第 1 步，直接：

```powershell
# 本机已有 MySQL
.\deploy\setup-server.ps1 -MySqlRootPassword 'root口令'

# 用阿里云 RDS（先在控制台建好实例/库/账号，并把 ECS 内网 IP 加进白名单）
.\deploy\setup-server.ps1 -MySqlHost 'rm-xxxxxx.mysql.rds.aliyuncs.com' `
  -MySqlUser forum_app -MySqlPassword 'RDS账号口令' -MySqlRootUser forum_app -MySqlPassword 'RDS账号口令'
```

MySQL 从零要怎么建、RDS 怎么配、出问题怎么查，都在 **[`deploy/mysql/README-阿里云MySQL.md`](deploy/mysql/README-阿里云MySQL.md)**。

### 部署脚本做了什么

| 步骤 | 内容 |
| --- | --- |
| 1 | 建目录 `C:\forum\{app,data,logs,backups,certs,runtime}` |
| 2 | 检测/停止占用端口的旧实例 |
| 3 | 下载便携版 Node（不改系统 PATH），或复用已有 |
| 4 | 复制应用代码到 `C:\forum\app` |
| 5 | **MySQL**：缺则调用 `install-mysql.ps1` 安装 → 建库建账号建表 → `npm install mysql2`（阿里云 npm 镜像） |
| 6 | 迁移历史数据：把 `data/forum.json` 导入 MySQL（库里已有用户则自动跳过） |
| 7 | 生成自签 TLS 证书（HTTPS） |
| 8 | 写 `forum.env.cmd` + `forum.mysql.env.cmd` + `run-forum.cmd` |
| 9 | 注册计划任务 `ComputerClubForum`（开机自启 + 崩溃自动重启） |
| 10 | 防火墙放行端口；**阿里云安全组仍需自行放行** |
| 11 | `/healthz` 自检（含 MySQL 探活） |
| 12 | 注册每日 03:00 备份任务 `ComputerClubForumBackup` |

---

## 2. 本地开发（不改服务器）

本地没有 MySQL 时用 JSON 存储跑起来最快：

```powershell
cd computer-club-forum
npm install                                    # 只为装 mysql2；本地跑 json 时可不装
$env:FORUM_STORE='json'; node server.mjs       # http://127.0.0.1:8210
node self-test.mjs                             # 自测（MySQL 连不上会自动跳过那部分）
```

本地想连真 MySQL：

```powershell
$env:FORUM_STORE='mysql'
$env:FORUM_MYSQL_HOST='127.0.0.1'
$env:FORUM_MYSQL_USER='forum_app'
$env:FORUM_MYSQL_PASSWORD='你的口令'
$env:FORUM_MYSQL_DATABASE='forum'
node server.mjs
```

---

## 3. 数据存储（MySQL）

### 3.1 连接参数（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FORUM_STORE` | `mysql` | 存储类型：`mysql` / `sqlite` / `json` |
| `FORUM_MYSQL_HOST` | `127.0.0.1` | MySQL 地址；RDS 填**内网地址** |
| `FORUM_MYSQL_PORT` | `3306` | 端口 |
| `FORUM_MYSQL_USER` | `root` | 账号，生产建议用 `forum_app` |
| `FORUM_MYSQL_PASSWORD` | 空 | 口令 |
| `FORUM_MYSQL_DATABASE` | `forum` | 库名 |
| `FORUM_MYSQL_TABLE_PREFIX` | 空 | 表前缀，一个库放多个论坛时用（如 `club_`） |
| `FORUM_MYSQL_SSL` | 空 | 设 `1` 启用 TLS（RDS 建议开） |
| `FORUM_MYSQL_SSL_CA` | 空 | CA 证书路径 |
| `FORUM_MYSQL_POOL_SIZE` | `4` | 连接池大小 |

服务器上这些参数写在 `C:\forum\forum.env.cmd` 与 `C:\forum\forum.mysql.env.cmd`，改完重启计划任务生效。

### 3.2 表结构

5 张表（`deploy/mysql/01-schema.sql` 与应用内建表语句完全一致，重复执行安全）：

| 表 | 主键 | 说明 |
| --- | --- | --- |
| `users` | `username` | 昵称、角色、封禁标记、scrypt 口令摘要、注册时间 |
| `posts` | `id` | 板块、作者、标题、正文、图片标记、置顶、发帖时间 |
| `replies` | `(post_id, floor)` | 楼层、作者、正文、图片标记、回复目标、时间 |
| `sessions` | `token` | 登录态（重启服务不掉线），带过期时间与索引 |
| `meta` | `key` | `seq`（ID 计数）等运行状态 |

时间统一存 **毫秒时间戳（BIGINT）**，字符集 **utf8mb4**，中文昵称与帖子不会乱码。

### 3.3 设计取舍（为什么是「内存 + 事务全量重写」）

- 200 人规模的数据量极小，启动时一次性读进内存，所有读接口零 SQL、零等待；
- 每次变更在一个事务里整体重写全部表，**要么全成功要么全失败**，不存在「写一半」的坏数据；
- 会话单独增量读写（登录/退出/清理），所以重启服务器社员不用重新登录；
- 数据量涨到几万帖后如需更低写入开销，可以改成增量 UPSERT——`src/storage/mysql.mjs` 里
  `writeAll()` 是唯一入口，改造点集中在这一处。

---

## 4. 数据迁移（旧 JSON → MySQL）

自动：**MySQL 里 `users` 表为空**且项目目录下存在 `data/forum.json` 时，服务启动会自动导入，
并把原文件改名为 `forum.json.migrated` 留档。

手工（推荐，能看到结果）：

```powershell
cd C:\forum\app
node ops.mjs migrate     # 幂等：库里已有用户就跳过
node ops.mjs status      # 用户/帖子/回复/会话数量
node ops.mjs verify      # 校验作者与楼层自洽
node ops.mjs backup C:\forum\backups
node ops.mjs ping        # 只测数据库连通性
node ops.mjs schema      # 打印建表 SQL
```

迁进来的历史数据里可能有测试账号（`测试丙`、`压力1`~`压力5`）：

```powershell
node server.mjs --prune          # 清掉这些临时账号
node server.mjs --clear          # 或整体清空，开张用
node server.mjs --clear --serve  # 清空后继续启动服务
```

---

## 5. 内网访问规则（公网仍然拒绝）

| 来源 | 默认结果 |
| --- | --- |
| `127.0.0.0/8`（本机） | 放行 |
| `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`（校园网/VPC 内网） | 放行 |
| `169.254.0.0/16`、`::1/128`、`fc00::/7`、`fe80::/10` | 放行 |
| 公网地址（如 `8.8.8.8`、服务器公网 IP 直连） | **拒绝** |
| 内网内但未携带正确 `?code=` | 拒绝 |

所以正确的用法是：**通过校园网 / VPN / 跳板机访问服务器的内网 IP**，不要用公网 IP 直连。
若确实需要额外放行某些网段（例如 WireGuard 的 `10.8.0.0/24`）：

```powershell
$env:FORUM_ALLOW_CIDRS='10.8.0.0/24,100.64.0.0/10'
```

被拒绝的来源地址会打印在日志里；管理员在网页上点「访问诊断（内网/数据库）」还能看到最近的拒绝记录、
当前放行网段与数据库连接信息，照着补白名单即可。

---

## 6. 环境变量总表

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8210` | 监听端口（部署脚本默认设成 `8443`） |
| `FORUM_HOST` | `0.0.0.0` | 监听地址；改回 `127.0.0.1` 则只允许本机 |
| `FORUM_STORE` | `mysql` | 存储类型：`mysql` / `sqlite` / `json` |
| `FORUM_MYSQL_*` | 见 3.1 | MySQL 连接参数 |
| `FORUM_ALLOW_CIDRS` | 空 | 额外放行网段，逗号分隔 |
| `FORUM_TRUSTED_PROXIES` | 空 | 信任的反向代理地址，用于采信 `X-Forwarded-For` |
| `FORUM_ACCESS_CODE` | 空 | 访问口令 `?code=...`，强烈建议设置 |
| `FORUM_ADMIN_USER` | 空 | 启动时把该用户名提升为管理员 |
| `FORUM_ADMIN_CODE` | 空 | 注册时填该口令即成为管理员 |
| `FORUM_WARN_ONLY` | 空 | 设 `1` 时违规内容只警告、不拦截 |
| `FORUM_TLS_CERT` / `FORUM_TLS_KEY` | 空 | 同时提供则用 HTTPS 启动 |
| `FORUM_LOG` | 空 | 启动信息与拒绝记录追加写入该文件 |
| `FORUM_DATA_FILE` / `FORUM_DB_FILE` | `data/forum.json` / `data/forum.db` | 仅 json / sqlite 存储用到 |
| `FORUM_SESSION_TTL_MS` | `2592000000` | 登录态有效期（默认 30 天） |

---

## 7. 功能与指令

- **用户体系**：`注册：用户名xxx` 建立独立身份；有效账号上限 **200**，超出直接拒绝。
- **发帖**：文字、学习资料、文档笔记；图片用 `【图片：xxx】` 标记模拟，不产生真实文件。
- **板块**：学习资料区 / 闲聊交流区 / 问答求助区。
- **交互**：每帖显示 用户名 + 时间 + 板块 + 内容，支持楼层回复（楼主 1 楼）。
- **限制**：仅内网/VPN 网段 + 访问口令；内置审核规则拦截外部链接、联系方式、广告与违规内容。

| 指令 | 说明 |
| --- | --- |
| `注册：用户名你的昵称，密码=你的密码` | 注册并登录（第 200 人之后拒绝） |
| `登录：用户名xxx，密码=你的密码` / `退出` | 换设备登录 / 退出 |
| `发帖：板块=学习资料区，内容=xxx【图片：说明】` | 发帖，支持模拟图片标记 |
| `查看全部帖子` / `查看板块【闲聊交流区】` | 帖子列表 / 按板块筛选 |
| `查看帖子ID:1 的全部回复` | 查看单帖全部楼层 |
| `回复帖子ID:1，内容=xxx` | 跟帖回复 |
| `删除帖子ID:1` / `置顶帖子ID:1` / `封禁用户xxx` / `清空全部数据` | 仅管理员 |

网页同时提供图形界面（板块导航、帖子列表、楼层详情、发帖表单、访问诊断）和底部指令控制台，
两条路径共用同一套服务端逻辑与审核规则。

---

## 8. 长期稳定运行

**不要让论坛服务挂在一次性的会话窗口里**。服务器上用部署脚本注册的计划任务即可：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `schtasks /Query /TN ComputerClubForum /V /FO LIST` |
| 重启服务 | `schtasks /End /TN ComputerClubForum ; schtasks /Run /TN ComputerClubForum` |
| 停止服务 | `schtasks /End /TN ComputerClubForum` |
| 看运行日志 | `C:\forum\logs\forum.log`、`C:\forum\logs\server-stdout.log` |
| MySQL 服务 | `Get-Service MySQL80` |

本地开发想要开机自启，用根目录的 `install-autostart.ps1`（记得先把 `FORUM_MYSQL_*` 写进系统环境变量）。

---

## 9. 故障排查对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `连接 MySQL 失败 ... ECONNREFUSED` | MySQL 没起来 / 端口不对 | `Get-Service MySQL80`；`Test-NetConnection 127.0.0.1 -Port 3306` |
| 报 `未安装 MySQL 驱动 mysql2` | `node_modules` 缺失 | `cd C:\forum\app ; npm install mysql2 --registry=https://registry.npmmirror.com` |
| `/healthz` 返回 503 | 数据库探活失败 | 响应体里的 `dbError` 直接给出原因 |
| 打开是 403 页面 | 需要访问口令，或来源不在放行网段 | 用带 `?code=口令` 的地址；确认走的是内网/VPN |
| 公网 IP 打不开 | 这是**预期行为**（公网来源一律拒绝） | 走内网 IP / VPN，或用 `FORUM_ALLOW_CIDRS` 精确放行 |
| 所有人突然都打不开 | 服务进程退出（窗口关闭/机器重启） | `schtasks /Run /TN ComputerClubForum`；看 `logs\forum.log` 末行 |
| 提示「账号已达上限 200 人」 | 有效账号满了 | 管理员 `封禁用户xxx` 释放名额，或 `清空全部数据` |
| 登录提示「用户不存在」 | 该昵称还没注册 | 先 `注册：用户名xxx`；换设备再用 `登录：用户名xxx` |
| 中文显示成问号 | 库字符集不是 utf8mb4 | 按 `deploy/mysql/01-schema.sql` 重建库 |
| 重启后大家掉线 | `sessions` 表写入失败 | `node ops.mjs status` 看会话数；检查 `forum_app` 的 INSERT/DELETE 权限 |

---

## 10. 自测

```powershell
node self-test.mjs
```

自测做三件事：① 校验内网白名单判定（22 项放行/拒绝用例）；
② **MySQL 正式路径**（连库、读表、会话，连不上则跳过并提示原因）；
③ 在项目内 `.selftest/` 起一个随机端口的临时实例，实测「无口令 403 / 有口令 200、管理员注册、
图片标记识别、楼层回复、违规内容拦截、访问诊断仅管理员可见、清空数据」，跑完自动清理。

> 说明：本机没有 MySQL，因此 `src/storage/mysql.mjs` 只做了语法与流程校验，**尚未对着真实数据库跑过**。
> 建议第一次部署时按下面顺序确认（每一步都有明确输出）：
>
> ```powershell
> node ops.mjs ping          # 1. 连库 + 打印 MySQL 版本
> node ops.mjs migrate       # 2. 导入 forum.json，打印用户/帖子数量
> node ops.mjs status        # 3. 复查数量
> node ops.mjs backup C:\forum\backups   # 4. 产出 .sql 备份文件
> ```
>
> 这四步都通过后再启动服务，然后 `Invoke-RestMethod http://127.0.0.1:8443/healthz` 应返回
> `"store":"mysql"`、`"dbOk":true`。

---

## 11. 文件

| 路径 | 说明 |
| --- | --- |
| `server.mjs` | HTTP 服务：接口、指令解析、审核、内网访问控制、200 人上限 |
| `src/storage/mysql.mjs` | **MySQL 存储**（mysql2 连接池、事务全量重写、会话增量、备份） |
| `src/storage/sqlite.mjs` / `json.mjs` | 单机/本地开发用的备选存储 |
| `src/storage/index.mjs` | 按 `FORUM_STORE` 选择存储实现 |
| `ops.mjs` | 运维命令：`status` / `verify` / `migrate` / `backup` / `schema` / `ping` |
| `self-test.mjs` | 白名单、MySQL 路径与运行时接口自测 |
| `public/` | 网页界面（`index.html` / `styles.css` / `app.js`） |
| `deploy/setup-server.ps1` | 阿里云 Windows Server 一键部署（MySQL 版） |
| `deploy/mysql/install-mysql.ps1` | 一键安装 MySQL 8（ZIP 版 + Windows 服务） |
| `deploy/mysql/setup-mysql.ps1` | 建库、建应用账号、建表、自检 |
| `deploy/mysql/01-schema.sql` | 建库建表脚本（可手工在 Workbench/DMS 执行） |
| `deploy/mysql/README-阿里云MySQL.md` | **阿里云 MySQL 部署手册**（自装 / RDS / 排错 / 安全清单） |
| `install-autostart.ps1` / `start.bat` / `stop.bat` | 本地开发用的启停与自启脚本 |
| `data/forum.json` | 历史数据（迁移后留档为 `forum.json.migrated`） |
