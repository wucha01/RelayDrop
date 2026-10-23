# RelayDrop 互联

面向 Windows 电脑、安卓手机和平板的本地文件与文字中转站。设备可以创建自己的文件池；电脑关闭后，安卓设备也可单独建池并与另一台安卓设备互传。

此目录是 **1.9.2 的独立源码整理版**。保留 EXE、APK 的操作方式，提供全新的开发版构建身份，不包含个人文件池、连接凭据、正式签名私钥或个人图片素材。项目自有代码和文档采用 [MIT 许可证](LICENSE)，版权署名为 `RelayDrop contributors`。第三方组件继续遵守各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 功能与边界

- 文件池共享目录、整文件夹上传、分类筛选、搜索定位、常用目录和最近打开。
- 批量整理、后台保存、离线本机副本、目录结构保留和任务进度。
- 图片缩略图、相册、文本和 PDF 预览；不同主机的媒体预览能力可能不同。
- SHA-256 完整性校验、分块恢复、重复文件提示、回收站、备份导出与迁移。
- TLS 加密、首次核对证书指纹、设备配对和撤销；主机仍可读取存放在自己文件池中的原件。
- Windows 独立窗口、托盘及系统发送入口；Android 分享入口、前台服务和蓝牙功能。

局域网使用需要设备可达，校园网的客户端隔离可能阻止发现或连接。Windows 蓝牙功能调用系统工具；安卓间蓝牙直传不是与 Windows 自定义协议的完全对等实现。远程模块保留源码，但本项目不提供已部署的公共中继，跨网络连接仍需自行配置可达的服务。预览文件会产生流量；缩略图不等于下载完整原件。具体安全边界见 [SECURITY.md](SECURITY.md)。

## 快速开始

需要 Node.js 22.13.0 或更高版本及 npm，建议使用 Node.js 24。首次安装依赖需要联网，版本与完整性校验固定在 `package-lock.json` 中。Windows 桌面构建需在 Windows 上运行；Android 还需 JDK 和 Android SDK，详见下方文档。

```sh
npm ci
npm test
npm run audit:source
npm start
```

`npm start` 启动本地中转站，运行数据写入本目录下被忽略的 `data/`，也可以通过 `RELAY_DATA` 指向专用数据目录。运行后按控制台提示打开界面。首次启动会生成自己的身份与配对信息；不要把生成的 `data/` 提交到 GitHub。桌面界面开发可运行 `npm run desktop`。

## 构建

```sh
npm run build:icons
npm run build:vendor
npm run build:android -- --sdk-root "C:\Android\Sdk" --java-home "C:\Java\jdk"
npm run build:windows
```

`build:desktop` 是 `build:windows` 的别名。默认生成 **Development / Dev** 应用，使用独立名称、包名与数据目录；它们不是现有正式版的更新安装包。开发 APK 使用临时开发签名，不能覆盖原签名 APK；重复生成后安装同包名的开发 APK 可能需要先卸载开发版，这会清除开发版数据。

Windows 默认不内嵌 APK，也不显示无效的 APK 下载入口。如需在桌面中转站中下载本次开发 APK：

```sh
npm run build:windows -- --android-apk dist/RelayDrop-Android-dev.apk
```

- [Windows 构建与应用身份](docs/WINDOWS-BUILD.md)
- [Android 工具链、开发签名与正式签名](docs/ANDROID-BUILD.md)
- [源码结构与整理范围](docs/SOURCE-PACKAGE.md)
- [贡献与验证约定](CONTRIBUTING.md)
- [本次构建和测试记录](docs/VERIFICATION.md)

正式 Android 构建只能显式指定仓库外的签名材料。保管好原签名和备份，不要为了运行示例而重建或替换旧签名。Windows 构建默认不执行代码签名，也不自动上传或发布。

## 仓库与数据

源码目录、软件运行数据、构建缓存和安装包是不同的内容。`data/`、`.build/`、`dist/`、`node_modules/`、本地环境文件和密钥均不属于源码发布内容。请在上传前执行 `npm run audit:source -- --strict-clean`；该模式要求先把安装依赖、运行数据及构建产物移出待发布目录。正常开发副本可用不带该参数的审计命令。

关闭程序不会自动删除文件池，删除源码目录也不能代替备份。迁移或升级正式程序之前，请使用软件内的备份导出并保存好原签名。自动化测试和本机构建不能替代真实手机、平板、校园网和长时间运行测试；不要将源码整理完成表述为已经通过全面安全审计或所有设备兼容认证。
