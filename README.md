# 我的记账本（个人记账软件 · GitHub 同步版）

纯网页应用：**数据存在你自己的 GitHub 私有仓库**，手机和电脑共用同一份数据，**自动同步**。
部署到 **GitHub Pages** 后，所有设备都从同一个网址访问，不需要任何本地服务器。

## 功能

- **GitHub 自动同步**：改动自动推送、每 60 秒自动检测云端变化并合并；多设备同时修改不丢数据（按记录合并、较新版本胜出、删除用墓碑防复活）
- **多账本**：日常 / 家庭 / 旅行 / 项目…相互独立，一键切换
- **记一笔**：收入 / 支出、金额、分类、日期、备注
- **明细筛选**：按月份 / 类型 / 分类 / 关键词
- **月度统计**：支出、收入、结余、笔数；分类占比 + 近 6 个月趋势图
- **预算管理**：每月总预算 + 分类预算，实时显示已用 / 剩余 / 超支
- **分类管理**：内置 + 自定义分类
- **导入 / 导出**：CSV、JSON 完整备份与恢复
- **旧数据迁移**：电脑首次使用时自动导入旧版 SQLite 数据（`data/bookkeeper.db`）
- **隐私**：数据只进你自己的 GitHub 私有仓库，不经过任何第三方服务器

## 推荐用法：全部设备从 GitHub Pages 访问

```
手机 ──┐
       ├─→ https://你的用户名.github.io/app-bookkeeper/（GitHub Pages）
电脑 ──┘            │
                    ▼ 自动同步
        你的 GitHub 私有数据仓库（bookkeeper-data / data.json）
```

电脑**不需要**安装 Node、不需要开启任何服务，打开同一个网址即可，和手机完全一致。

### 第一步：准备两个仓库（推荐）

| 仓库 | 可见性 | 用途 |
| --- | --- | --- |
| `app-bookkeeper` | 公开（不含数据，公开安全） | 放 4 个网页文件（index.html / style.css / app.js / sync-core.js），开启 Pages |
| `bookkeeper-data` | **Private（必须）** | 只存数据文件 `data.json`（第一次同步时自动创建） |

> 为什么分开？网页和数据放在同一个仓库也可以，但你在 Git 推送网页更新时，会和应用自动提交的 `data.json` 产生冲突，需要手动 `git pull`，比较麻烦。分开后数据仓库完全由应用自动管理，互不干扰。

### 第二步：生成 Token（一次性）

按 GitHub 最新界面（fine-grained 令牌已于 2025 年 3 月正式全面可用，推荐类型）：

1. 登录 GitHub，点右上角**头像 → Settings**
2. 左侧滚动到最底部 → **Developer settings**
3. 左侧 **Personal access tokens** → **Fine-grained tokens**
4. 点 **Generate new token**
5. **Token name**：起个名字，如 `bookkeeper-sync`
6. **Expiration（有效期）**：可选 7 / 30 / 60 / 90 天、自定义日期，或直接选 **No expiration（永不过期，GitHub 现支持）**——个人记账建议选永不过期，省得每年换
7. **Description**：选填，如「我的记账本同步用」
8. **Resource owner（资源所有者）**：选择你的 GitHub 用户名（若仓库建在组织下则选对应组织）
9. **Repository access**：选 **Only select repositories** → 勾选数据仓库 `bookkeeper-data`
10. **Permissions → Repository permissions**：找到 **Contents** → 权限选 **Read and write**（此时 **Metadata** 会自动设为 Read-only，这是必需的，保持默认即可）
11. 点页面底部 **Generate token**
12. 复制生成的令牌（`github_pat_...`）——**只显示这一次**，请先保存好

### 第三步：部署网页到 GitHub Pages

方式 A（无需 git，网页上传）：

1. 打开 GitHub → 新建仓库 `app-bookkeeper`（公开）
2. 仓库页面 → Add file → **Upload files** → 把电脑上 `D:\deepseek\bookkeeper\public\` 里的 4 个文件（index.html / style.css / app.js / sync-core.js）拖进去 → Commit
3. 仓库 → **Settings** → 左侧 **Pages** → Source 选 `Deploy from a branch` → 分支 `main`、目录 `/ (root)` → **Save**
4. 等 1~2 分钟，浏览器打开 `https://你的用户名.github.io/app-bookkeeper/`

方式 B（用 git 命令行推送，适合以后经常更新）：

```bash
cd D:\deepseek\bookkeeper\public
git init
git add .
git commit -m "bookkeeper web"
git branch -M main
git remote add origin https://github.com/你的用户名/app-bookkeeper.git
git push -u origin main
```

然后在仓库 Settings → Pages 里选 `main` 分支的 `/ (root)` 开启。

### 第四步：每台设备配置同步

每台设备第一次打开网页时，点右上角「**同步设置**」，填入：

- 仓库所有者 = 你的 GitHub 用户名
- 仓库名 = `bookkeeper-data`（数据仓库，不是应用仓库）
- Token = 第二步生成的令牌
- 「测试连接」→「保存并同步」

配置一次即可，之后打开网页自动同步（每台设备浏览器各存一份自己的 Token）。

> 电脑第一次配置时，如果之前用旧版存过数据（`data/bookkeeper.db`），会自动检测并一并上传——先确认旧数据没问题再点保存。

## 备选：电脑本地 Node 服务（可选）

不需要 Node 时请忽略本节。想在电脑本地跑一份（速度快、可离线开发）：

```bash
cd D:\deepseek\bookkeeper
node server.js          # 需要 Node.js ≥ 22.5
# 打开 http://127.0.0.1:3000（手机同 Wi-Fi 时用 HOST=0.0.0.0 启动，访问 http://电脑IP:3000）
```

## 同步机制

- 数据文件：数据仓库根目录的 `data.json`（应用自动提交，提交信息 `bookkeeper sync`）
- 修改后 **0.8 秒**防抖自动推送；推送冲突（另一台设备先改了）自动拉取 → 合并 → 重试，最多 3 次
- 每 **60 秒**自动检查云端变化并合并
- 顶栏状态：`✓ 已同步` / `⟳ 同步中…` / `◷ 待同步` / `⚠ 离线`，点击可立即手动同步
- 合并规则：按 id 合并两边的数据，同一记录取更新时间较新者；删除带墓碑标记，不会"复活"
- 完全离线时应用照常可用（数据在浏览器缓存里），恢复网络后自动补推

## 备份 / 恢复

- 点「导出 JSON」下载完整备份（含账本、预算、分类）
- 恢复：点「导入」选择备份文件，按提示确认覆盖
- 也可直接在 GitHub 数据仓库里查看 / 下载 `data.json`

## 常见问题

- **Token 无效 / 401**：确认 Token 是 fine-grained、勾选了 `bookkeeper-data` 仓库、Contents 为 Read and write；Token 丢失就重新生成；如果设置了有效期，**到期后也会报 401**——重新生成后到每台设备的「同步设置」里更新即可。
- **报错「Resource not accessible by personal access token」**：Token 有效但没被授权访问该仓库。最常见的三种原因：① 仓库名填错（或填成了应用仓库）；② 生成 Token 时没在 Only select repositories 里勾选数据仓库——**Token 生成早于仓库创建时尤其常见**，此时需要编辑 Token 重新勾选（Fine-grained Token 创建后可以随时编辑，不必重新生成）；③ Contents 权限没设为 Read and write。设置弹窗里会显示完整排查清单，按提示逐项检查即可。
- **Token 泄露**：到 Fine-grained tokens 页面点令牌右侧的删除/停用，再重新生成一个。
- **409 冲突**：正常现象，应用自动合并重试，无需处理。
- **Pages 打开是 404**：部署或开启 Pages 后需等 1~2 分钟生效；确认选择的分支和目录正确。
- **换了手机/浏览器**：新设备首次打开后需重新填一次同步设置（Token 可在不同设备上重复使用）。
- **想换数据仓库**：改配置里的仓库名再「保存并同步」；注意不同仓库数据不互通。
- **手动 git 推送网页更新**：只推 `app-bookkeeper`（应用仓库），不要动 `bookkeeper-data`。

## 项目结构

```
bookkeeper/
├── server.js          # 可选：本地静态托管（+ 旧 SQLite 数据导出接口）
├── package.json
├── README.md
├── data/              # 旧版 SQLite 数据（bookkeeper.db），仅用于电脑端一次性迁移
└── public/            # 网页应用（这 4 个文件就是部署到 Pages 的全部内容）
    ├── index.html
    ├── style.css
    ├── sync-core.js   # 数据模型 / 合并 / base64（纯函数，浏览器与 Node 通用）
    └── app.js         # 界面 + 同步引擎
```

## 本地服务 REST 接口（仅本地托管时可用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/legacy` | 导出旧版 SQLite 数据（`{exists, doc}`），供网页迁移 |

> 网页版数据读写全部走 GitHub API（api.github.com），不依赖本地接口。
