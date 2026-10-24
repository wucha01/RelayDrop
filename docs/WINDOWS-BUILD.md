# Windows 开发与打包

在 Windows 10/11 x64 上安装 Node.js 22.13.0 或更新版本，然后在源码根目录运行：

```powershell
npm ci
npm test
npm run build:windows
```

`npm ci` 从锁文件安装 Electron 45.0.0 和 electron-builder 26.15.3 的构建依赖。Electron 45 需要显式安装运行时，因此构建脚本会在运行时缺失时调用该版本自带的官方安装器，并使用其发行包校验清单。首次打包需要联网下载 Electron、NSIS 等工具。无需全局安装 Electron、Python 或 Visual Studio。

只从源码启动开发窗口、不打包时，运行 `npm run desktop`。它会先自动准备锁定版本的 Electron；也可单独运行 `npm run prepare:desktop` 预下载运行时。

构建输出位于 `dist/windows-development/`：

- `RelayDrop-Development-Desktop-1.9.3-x64.exe`：便携版。
- `RelayDrop-Development-Setup-1.9.3-x64.exe`：当前用户安装版。
- `build-report.json`：输入和输出的 SHA-256，以及相对路径。

源码快照和构建缓存位于 `.build/`。这些目录均为本机构建产物，不应提交到 GitHub。程序代码保存在每次构建独立生成的快照中；构建结束后会逐文件核对源码、快照及 `app.asar`，源码中途变化会使构建失败。该检查验证打包内容一致性，不保证不同机器生成的 EXE 逐字节相同。

构建会在 `app.asar` 内保留根目录 MIT `LICENSE`、第三方声明及随附许可文本。分发应用时须保留这些文件及 Electron 自带的许可说明。

## 开发版隔离

默认构建和直接从源码运行均使用开发版身份：

| 项目 | 开发版 | 正式发行身份 |
| --- | --- | --- |
| 显示名称 | 星月夜开发版 | 星月夜 |
| 应用 ID | `app.relaydrop.desktop.development` | `app.relaydrop.desktop` |
| 本机数据目录 | `%LOCALAPPDATA%/RelayDropDesktopDevelopment` | `%LOCALAPPDATA%/RelayDropDesktop` |
| EXE 名称 | `RelayDropDevelopment.exe` | `RelayDrop.exe` |
| “发送到”与启动项名称 | 星月夜开发版 | 星月夜 |

开发版与正式版分别使用独立的安装目录、托盘实例、文件池、设备身份、已保存记录和浏览器会话。安装器不自动启动程序，卸载保留应用数据。首次启动开发版会创建新的文件池，需要重新配对；不同发行身份之间的数据需通过备份与导入迁移。

`RELAY_DESKTOP_DATA` 可显式指定另一个绝对数据目录，用于隔离测试。设置它意味着主动覆盖上述默认位置，请勿指向正在使用的文件池。`RELAY_DESKTOP_HOST=127.0.0.1` 可将测试服务器限制在本机；`RELAY_DESKTOP_PORT=0` 可选择空闲端口。

仅生成可直接启动的解包目录：

```powershell
npm run build:windows -- --dir
```

启动 `dist/windows-development/win-unpacked/RelayDropDevelopment.exe` 即可。运行后通过托盘菜单“退出并停止共享”完全关闭。

## 可选内置安卓安装包

Windows 源码构建默认不包含 APK。没有 APK 时应用不显示安卓 APK 下载卡片，文件池与设备互传仍可使用。先按 [安卓构建说明](ANDROID-BUILD.md) 生成自己的开发 APK，再显式指定它：

```powershell
npm run build:windows -- --android-apk ./dist/RelayDrop-Android-dev.apk
```

参数接受自行构建的 APK 路径；构建仅包含显式指定的安装包。构建报告记录 APK 哈希，不记录其在构建机器上的绝对路径。

## 正式发行身份

只有明确指定以下参数，才会采用正式应用 ID 和现有正式版数据目录：

```powershell
npm run build:windows -- --release
```

结果位于 `dist/windows-release/`。这个选项用于维护者准备发行，不适合作为隔离测试方式：安装或运行后会与现有正式版共享身份与数据位置。使用自己的分支长期发行时，应先修改应用 ID、产品名和数据目录，避免与其他发行版冲突。

所有构建默认禁用 Windows 代码签名和自动发布，包括 `--release`。构建脚本不自动使用本机证书，也不创建 GitHub Release。应用内的 TLS 设备身份在首次启动时生成，不属于发行包。需要代码签名时，应在受控的发布流程中显式配置证书，并将证书和密钥保存在仓库外。

## 图标资源

当前公开包使用源码中的绿色图标。桌面图标位于 `desktop/assets/`，Android 启动图标位于 `android/res/`，README 图片位于 `docs/assets/app-icon.png`。替换图标资源不需要更改包名、签名或数据目录；替换后须更新资源审计清单并重新构建对应安装包。`npm run build:icons` 可从 `desktop/assets/icon.svg` 生成桌面 PNG/ICO。

正式发行时如需在 Windows 内置同版本 Android 安装包：

```powershell
npm run build:windows -- --release --android-apk ./dist/RelayDrop-Android-release.apk
```
