# Android 构建

此源码使用 Android SDK 的官方命令行工具构建 Java 应用，不需要 Android Studio 或 Gradle。当前脚本支持 **Windows PowerShell 5.1、Windows 上的 PowerShell 7**；其他操作系统尚未验证。

## 准备工具

- Node.js 22.13.0 或更新版本，用于统一的 `npm run` 入口；也可以直接执行 PowerShell 脚本。
- JDK 17 或更新版本，设置 `JAVA_HOME`。
- Android SDK，设置 `ANDROID_SDK_ROOT`（也兼容 `ANDROID_HOME`）。安装 `platforms;android-35`、`build-tools;35.0.0`；需要安装调试时再安装 `platform-tools`。

使用 Android SDK Command-line Tools 安装组件：

```powershell
sdkmanager.bat "platforms;android-35" "build-tools;35.0.0" "platform-tools"
```

首次使用需按 Android SDK 工具提示接受对应许可。脚本不会自动下载 SDK、安装软件或修改系统环境变量。

`android/lib/nanohttpd-2.3.1.jar` 是随源码保留的第三方依赖，许可见同目录 `LICENSE-nanohttpd.md`，项目第三方声明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。脚本会核验固定 SHA-256：

```text
de864c47818157141a24c9acb36df0c47d7bf15b7ff48c90610f3eb4e5df0e58
```

## 默认开发构建

在项目根目录执行：

```powershell
npm run build:android
```

未设置环境变量时，可以显式传入本机工具路径：

```powershell
npm run build:android -- --sdk-root "C:\Android\Sdk" --java-home "C:\Java\jdk-17"
```

或直接执行脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\android\build.ps1
# 使用 PowerShell 7：
pwsh -NoProfile -File .\android\build.ps1
```

输出为 `dist/RelayDrop-Android-dev.apk`，应用显示名为 **星月夜开发版**，安装包名为 **app.relaydrop.dev**。开发版与包名为 `app.relaydrop` 的正式版拥有独立数据空间，可以同时安装。构建与运行开发版不需要正式版的应用数据或签名材料。

每次开发构建使用临时签名，开发签名证书的显示名称为 `RelayDrop Development`。构建结束（包括失败）时会清理生成的临时密钥和密码文件。中间产物位于 `.build/android/build-<随机编号>/`，源码目录中的 `.build/` 与 `dist/` 均应被 Git 忽略。

**每次开发构建的临时签名不同，后续开发 APK 无法覆盖安装已有开发版。** 重新安装前，先导出并确认文件池备份，再卸载对应的 `星月夜开发版`；卸载会清除其应用数据。长期测试或发布更新时，应使用下一节中的独立包名和固定签名进行 Release 构建。

安装开发 APK：

```powershell
adb install .\dist\RelayDrop-Android-dev.apk
```

脚本本身不会安装或启动 APK。APK 的 Java 类命名空间仍然是 `app.relaydrop`；构建时将 Manifest 组件转换为完整类名，并使用 `aapt2 --custom-package app.relaydrop` 生成资源类，因此独立安装包名不会破坏 Activity、Service 或通知图标引用。

APK 构建会在 `assets/licenses/` 保留根目录 MIT `LICENSE`、第三方声明、QR 与 NanoHTTPD 的许可文本。分发时须保留这些声明。

## 使用自己的固定签名构建

Release 构建必须显式指定包名、签名目录与密钥别名。签名目录必须位于源码目录之外，脚本只读取参数指定的签名材料。

准备以下文件，限制签名目录的访问权限，并单独妥善备份：

```text
外部签名目录/
  release.jks          Java KeyStore
  store-password.txt   KeyStore 密码（UTF-8，无 BOM，单行）
  key-password.txt     可选；私钥密码不同于 KeyStore 密码时提供
```

也兼容同一外部目录中名为 `relaydrop.jks` 和 `password.txt` 的成对文件；优先使用 `release.jks` 和 `store-password.txt`。目录内不应混用不完整的两种命名。

可以使用 JDK 的 `keytool -genkeypair` 交互创建自己的密钥，避免把密码写进命令历史；随后通过本机编辑器创建上述密码文件。不要将密钥、密码、个人证书或本机专用配置提交到 GitHub。

例如，使用独立包名构建供长期测试的安装包：

```powershell
npm run build:android -- --configuration Release --application-id org.example.relaydrop --app-label "星月夜测试版" --signing-directory "C:\PrivateKeys\RelayDrop" --key-alias my-relaydrop
```

将示例包名和路径替换为实际配置。输出为 `dist/RelayDrop-Android-release.apk`。签名文件由发布者管理，构建脚本仅以只读方式使用这些文件。为已安装的应用发布覆盖更新时，包名与签名证书必须保持一致，并使用合适的递增版本号；更换签名证书的同包名 APK 无法直接覆盖安装。

所有模式均先校验输入，再在独立目录构建，最后执行 APK 签名验证和 ZIP 对齐验证。`Development` 默认不启用调试权限。应用属性来自构建参数与项目配置。

## 参数

运行 `node scripts/build-android.cjs --help` 查看统一入口参数。PowerShell 参数包括 `Configuration`、`SdkRoot`、`JavaHome`、`ApplicationId`、`AppLabel`、`BuildDir`、`OutputApk`、`SigningDirectory`、`KeyAlias`。只有 Release 接受外部签名参数。

安卓端最低系统版本为 Android 8.0（API 26），目标版本为 API 35。实际设备的通知、后台任务、系统文件选择器、蓝牙和校园网连接仍需要真机测试；源码能够构建不等于已验证所有机型与网络。
