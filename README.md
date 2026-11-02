# 本地文件管理器

基于 Electron 的跨平台本地文件管理器，纯本地运行、不联网上传任何数据。

> 当前版本 **0.1.0**（早期开发中）。项目最初在 Linux 上开发，现已针对 Windows 做过一轮排查修复。

## 功能

- **文件浏览**：侧边栏快捷目录、面包屑导航、前进/后退/上一级、列表/网格双视图、点击表头排序
- **打开**：双击文件夹进入，双击文件用系统默认程序打开
- **搜索与筛选**：按名称递归搜索（含子目录），可按类型（图片/文档/视频/音频/压缩包）、大小范围、修改时间范围组合筛选
- **文件文库**：文库 → 大类 → 组 → 文件 的三级归档结构，支持标签、封面、迁移、重新定位
- **整理与归档**：一键归类（按类型自动建子文件夹）、批量重命名（模板 + 起始编号 + 编号位数）
- **文件操作**：新建文件夹、重命名、复制/剪切/粘贴（Ctrl+C / X / V）、移入系统回收站（Delete）
- **安全设计**：删除走系统回收站（Electron `shell.trashItem`）；界面进程与文件操作进程隔离；主进程限制访问范围

## 在 Windows 上运行

**日常使用不需要装 Node.js。** 依赖装好后，双击 `start.bat` 即可，它直接调用
`node_modules\electron\dist\electron.exe`，不再经过 node / npm。

只有下面两种情况才需要 Node.js（18+）：

1. 第一次运行，要下载 Electron（约 100MB，需联网）
2. 打包成安装包（双击 `打包成安装包.bat`）

`start.bat` 找不到 node 时会去常见安装位置再找一遍（Program Files\nodejs、
`%LOCALAPPDATA%\Programs\nodejs`、nvm、fnm 等），都找不到才报错。

## 在其他平台运行

```bash
git clone <你的仓库地址>
cd FileManager
npm install
npm start
```

## 打包成安装包

| 目标平台 | 命令 | 产物 |
|----------|------|------|
| Windows | `打包成安装包.bat` 或 `npm run dist:win` | `release/*.exe`（NSIS 安装包） |
| Linux | `npm run dist:linux` | `release/*.AppImage` |
| macOS | `npm run dist:mac` | `release/*.dmg` |

注意：
- Windows 安装包建议在 Windows 电脑上打包（或在其他平台安装 Wine）
- 打包产物在 `release/` 目录，已被 .gitignore 排除，不会提交
- 打包后的程序是独立应用，无需再装 Node.js

> 手机端说明：Electron 不支持手机。若需要手机访问文件，可后续改造为局域网 Web 应用。

## Windows 上的注意事项

本项目源自 Linux 开发环境，以下差异已经修复，后续改动时请注意保持：

| 项目 | Linux | Windows |
|------|-------|---------|
| 允许访问的根目录 | `/media`、`/mnt` 等 | 各盘符根目录（C:\\、D:\\…） |
| 文件名 | `<>:"/\|?*` 都合法 | 非法；另有 CON/PRN/AUX/NUL/COM1~9/LPT1~9 保留名 |
| 文件名大小写 | 敏感 | 不敏感（只改大小写不算"同名"） |
| 跨盘/跨分区移动 | `rename` 可能失败 | 同上，需退回"复制后删除" |
| 用户目录（桌面/文档/下载…） | `~/Desktop` 等 | 可能被 OneDrive 重定向，要用 `app.getPath()` |

## 文件结构

| 文件 | 职责 |
|------|------|
| main.js | 主进程：所有文件系统操作 IPC 接口 |
| preload.js | 安全桥接：暴露 window.api |
| index.html / styles.css / renderer.js | 界面与交互逻辑 |
| start.bat | Windows 一键启动（无需 Node.js） |
| 打包成安装包.bat | Windows 一键打包成 .exe 安装包 |
| 文件库/ | 示例文库（含账本 `.library-index.json`） |

## 版本维护建议

- 修改代码后提交：`git add -A && git commit -m "说明"`
- 发布新版本：改 `package.json` 的 `version`（当前 `0.1.0`），打包后可上传到 GitHub Releases
- 版本格式为 `主版本.次版本.修订号`（semver），`electron-builder` 会用它命名安装包
