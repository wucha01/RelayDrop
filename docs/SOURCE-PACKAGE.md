# 源码与数据目录

源码仓库包含 RelayDrop 的应用代码、构建入口、公开依赖和文档。运行时的文件池、设备身份、配对凭据和发布签名不属于源码。

## 目录结构

| 位置 | 用途 |
| --- | --- |
| `server.cjs` 与根目录模块 | Node 文件池服务、完整性校验、访问权限、备份与设备发现 |
| `public/` | Windows、Android 与浏览器共用的界面 |
| `desktop/` | Electron 窗口、托盘、本机保存与预览 |
| `android/` | Android Java 源码、应用资源与构建入口 |
| `remote/` | 可选远程连接协议与中继源码 |
| `vendor/` | PDF/X509 资源、字体及二维码等组件的许可证 |
| `scripts/` | 构建入口、资源生成与源码审计 |
| `test/` | 使用合成数据的 Node 自动化测试 |
| `docs/` | 平台构建、源码与数据目录说明及验证范围 |

安装依赖和构建后会出现 `node_modules/`、`.build/`、`dist/` 等本机目录。它们已由 `.gitignore` 排除，不应作为源码提交。源码不附带 APK/EXE 是正常情况；没有可用 APK 时，应用会隐藏相应下载卡片，文件池功能仍可使用。

## 文件池保存位置

| 运行方式 | 默认位置 |
| --- | --- |
| Windows 开发版 | `%LOCALAPPDATA%\RelayDropDesktopDevelopment\relay-data` |
| Windows 正式发行身份 | `%LOCALAPPDATA%\RelayDropDesktop\relay-data` |
| `npm start` 启动的 Node 服务 | 源码根目录下的 `data/` |
| Android | 应用私有数据目录内的 `files/relaydrop/` |

Windows 的 `RELAY_DESKTOP_DATA` 可指定应用数据根目录，Node 服务的 `RELAY_DATA` 可指定文件池目录。通过应用迁移文件池后，实际位置可能与默认值不同，应以应用显示的位置为准。Windows 的偏好设置、设备记录等应用数据位于应用数据根目录；用户另行保存的文件副本位于保存时选择的目录。

关闭程序不会自动删除文件池。Android 卸载应用或清除应用数据会删除应用私有数据；更换设备、重装应用或调整磁盘前，请先使用备份或导出功能保存文件。不要把私有数据目录复制进 Git 仓库，也不要用源码 ZIP 代替文件池备份。

默认开发版使用独立应用身份和数据空间，不会自动导入正式版的文件池。测试时请使用独立目录，不要将环境变量指向正在使用的文件池。详见 [Windows 构建](WINDOWS-BUILD.md)与 [Android 构建](ANDROID-BUILD.md)。

## 证书、签名与公开依赖

- `android/res/raw/webview_trust_anchor.pem` 是公开信任证书，不含私钥，也不是应用运行时生成的 TLS 设备身份。
- `android/lib/nanohttpd-2.3.1.jar` 是固定版本的第三方依赖，随附许可证，构建脚本会核对其哈希。
- 应用运行时生成的设备身份和配对凭据应保留在本机数据目录。发布所需的 Android 签名密钥和密码应保存在仓库外。
- Android 默认构建使用临时开发签名，每次构建的签名不同，不能据此覆盖已安装的上一份开发 APK。长期测试或发行需要使用自己的固定签名。
- Windows 默认构建未进行代码签名。开发构建和正式发行身份的区别见对应平台构建文档。

## 许可证与分发

项目自有代码和文档采用 [MIT 许可证](../LICENSE)。第三方代码、字体和资源仍遵循各自许可证，分发时须保留 [第三方声明](../THIRD_PARTY_NOTICES.md)及随附许可文本。

Windows 构建规则将项目许可证纳入应用资源；Android 构建规则将许可文件纳入 `assets/licenses/`。分发源码时应保留完整 `LICENSE`，分发安装包时应核对构建产物中的声明。具体构建检查范围见[验证与兼容性](VERIFICATION.md)。
