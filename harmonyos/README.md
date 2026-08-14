# 我的记账本 · 鸿蒙版（HarmonyOS NEXT）

一个极简的鸿蒙应用：启动后全屏加载你的 GitHub Pages 记账网页，**不需要每次打开浏览器**。
网页数据仍走 GitHub 自动同步，和电脑、其他手机完全一致。

## 适用条件

- 手机是 **HarmonyOS NEXT（鸿蒙 5.0+，API 12+）** 的鸿蒙原生应用
- 如果手机是鸿蒙 4 或安卓：不能装 .hap，请用浏览器「添加到主屏幕」代替（打开网页 → 菜单 → 添加到主屏幕，图标全屏打开，体验接近）

## 构建安装步骤（电脑端操作一次）

1. **安装 DevEco Studio**（华为官方 IDE，Windows/Mac）：
   下载地址：https://developer.huawei.com/consumer/cn/deveco-studio/
   安装时勾选 HarmonyOS SDK（API 12 及以上）

2. **修改网页地址**（关键！）
   用 DevEco Studio 或记事本打开 `entry/src/main/ets/pages/Index.ets`，
   把顶部 `APP_URL` 改成你自己的 GitHub Pages 地址：
   ```ts
   const APP_URL: string = 'https://你的用户名.github.io/app-bookkeeper/';
   ```
   （项目里默认填的是 `https://wuhaotdcq-s.github.io/app-bookkeeper/`，如果不是请改掉）

3. **打开工程**：DevEco Studio → File → Open → 选择本目录（`harmonyos/` 文件夹）
   - 首次打开会提示下载依赖/SDK，点同意等待完成
   - 如提示 hvigor 版本迁移，点同意即可

4. **配置签名**：File → Project Structure → Signing Configs → 勾选 **Automatically generate signature**
   （需要登录华为账号；这一步生成调试证书，手机上才能安装）

5. **连接手机安装**：
   - 手机开启「开发者模式」（设置 → 关于本机 → 连续点版本号 7 次）
   - 开启 USB 调试，用数据线连电脑
   - DevEco Studio 顶部选你的手机设备 → 点 Run ▶（或 Build → Build Hap(s)/App(s) 后手动安装）

6. **首次使用**：打开 App → 右上角「同步设置」→ 填入 用户名 / 数据仓库名 / Token → 保存并同步
   （和手机浏览器里配置一样，Token 存在 App 的网页缓存里，一次即可）

## 说明

- App 只是网页的壳（ArkWeb 组件），**网页代码更新时无需重新构建 App**，打开就是最新版
- 已处理：加载动画、断网/地址错误时的重试页、网页弹窗（删除确认、重命名输入）支持
- 数据、同步逻辑全部在网页里，与本 App 无关，配置一次后自动同步
- 隐私：App 仅请求 `ohos.permission.INTERNET` 网络权限，无其他权限

## 常见问题

- **构建报 SDK 版本错误**：改根目录 `build-profile.json5` 里 `compatibleSdkVersion` 为你 DevEco 支持的版本（如 `"5.0.1(13)"` 或 `"5.1.0(14)"`）
- **安装提示签名问题**：确认第 4 步自动签名已勾选，或重新生成签名
- **打开显示「无法连接到记账网页」**：先用手机浏览器确认 Pages 地址能打开；再检查 App 里 `APP_URL` 是否改对了
- **想改应用名/图标**：`AppScope/resources/base/element/string.json` 改 `app_name`；替换两个 `media` 目录下的 PNG（app_icon.png / startIcon.png，建议 512×512）

## 工程结构

```
harmonyos/
├── AppScope/                       # 应用级配置
│   ├── app.json5                   # 包名、版本、图标、名称
│   └── resources/base/...          # app_name、app_icon.png
├── entry/                          # 入口模块
│   └── src/main/
│       ├── module.json5            # 模块配置 + 网络权限
│       ├── ets/entryability/EntryAbility.ets
│       ├── ets/pages/Index.ets     # ★ 网页地址在这里改
│       └── resources/...           # startIcon.png、文案、启动背景
├── build-profile.json5             # SDK 版本、签名
├── hvigorfile.ts / hvigor/         # 构建工具配置
└── oh-package.json5
```
