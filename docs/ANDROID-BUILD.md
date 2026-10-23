# Android 构建

此源码使用 Android SDK 的官方命令行工具构建 Java 应用，不需要 Android Studio 或 Gradle。当前脚本支持 **Windows PowerShell 5.1、Windows 上的 PowerShell 7**；其他操作系统尚未验证。

## 准备工具

- Node.js 22.13.0 或更新版本，用于统一的 `npm run` 入口；也可以直接执行 PowerShell 脚本。
- JDK 17 或更新版本，设置 `JAVA_HOME`。
- Android SDK，设置 `ANDROID_SDK_ROOT`（也兼容 `ANDROID_HOME`）。安装 `platforms;android-35`、`build-tools;35.0.0`；需要安装调试时再安装 `platform-tools`。

安装 SDK 组件时使用你下载的 Android SDK Command-line Tools：

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

环境变量未设置时，也可以明确传入你自己机器上的工具路径：

```powershell
npm run build:android -- --sdk-root "C:\Android\Sdk" --java-home "C:\Java\jdk-17"
```

或直接执行脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\android\build.ps1
# 使用 PowerShell 7：
pwsh -NoProfile -File .\android\build.ps1
```

输出为 `dist/RelayDrop-Android-dev.apk`，应用名为 **RelayDrop Dev**，安装包名为 **app.relaydrop.dev**。它与原来的 `app.relaydrop` 应用拥有独立数据空间，可以并存。默认构建不会读取原应用的数据、私钥或签名配置，也不会覆盖已安装的原应用。

每次构建都会创建一个仅用于开发的临时签名，证书名称为通用的 `RelayDrop Development`，不写入开发者姓名或邮箱。构建结束（包括失败）时会删除本次创建的密钥和密码文件。中间产物位于 `.build/android/build-<随机编号>/`，源码目录中的 `.build/` 与 `dist/` 均应被 Git 忽略。

**临时签名每次都不同，因此第二次开发构建不能覆盖安装第一次的开发 APK。** 如果需要重新安装，先备份开发应用中的测试文件，再仅卸载 `RelayDrop Dev`；不要卸载个人正在使用的原应用。如果需要长期测试并保留开发数据，请使用下一节中的独立包名和自己的固定签名进行 Release 构建。

安装开发 APK：

```powershell
adb install .\dist\RelayDrop-Android-dev.apk
```

脚本本身不会安装或启动 APK。APK 的 Java 类命名空间仍然是 `app.relaydrop`；构建时将 Manifest 组件转换为完整类名，并使用 `aapt2 --custom-package app.relaydrop` 生成资源类，因此独立安装包名不会破坏 Activity、Service 或通知图标引用。

后续 APK 构建会在 `assets/licenses/` 保留根目录 MIT `LICENSE`、第三方声明、QR 与 NanoHTTPD 的许可文本。分发时须保留这些声明。

## 使用自己的固定签名构建

Release 构建必须显式指定包名、签名目录与密钥别名。签名目录必须放在源码目录之外；脚本从不自动查找本机原有签名，也不读取历史项目的签名环境变量。

自己准备以下文件，限制该目录的访问权限，并单独妥善备份：

```text
外部签名目录/
  release.jks          自己的 Java KeyStore
  store-password.txt   KeyStore 密码（UTF-8，无 BOM，单行）
  key-password.txt     可选；私钥密码不同于 KeyStore 密码时提供
```

也兼容同一外部目录中名为 `relaydrop.jks` 和 `password.txt` 的成对文件；优先使用 `release.jks` 和 `store-password.txt`。目录内不应混用不完整的两种命名。

可以使用 JDK 的 `keytool -genkeypair` 交互创建自己的密钥，避免把密码写进命令历史；随后通过本机编辑器创建上述密码文件。不要将密钥、密码、个人证书或本机专用配置提交到 GitHub。

例如，为自己的长期开发副本构建：

```powershell
npm run build:android -- --configuration Release --application-id org.example.relaydrop --app-label "RelayDrop Test" --signing-directory "C:\PrivateKeys\RelayDrop" --key-alias my-relaydrop
```

将示例包名和路径替换为你自己的值。输出为 `dist/RelayDrop-Android-release.apk`。此模式只读取外部签名文件，不创建、覆盖或删除它们。原签名私钥不包含在这个源码包内；拥有相同包名但使用不同证书的 APK 无法覆盖原应用。需要给原应用发更新时，只有原维护者应在私有环境中明确提供对应的原签名材料。

所有模式都先校验输入，再在独立目录构建，最后执行 APK 签名验证和 ZIP 对齐验证。`Development` 默认不启用调试权限。默认不使用构建机姓名、邮箱或仓库目录作为应用属性。

## 参数

运行 `node scripts/build-android.cjs --help` 查看统一入口参数。PowerShell 参数包括 `Configuration`、`SdkRoot`、`JavaHome`、`ApplicationId`、`AppLabel`、`BuildDir`、`OutputApk`、`SigningDirectory`、`KeyAlias`。只有 Release 接受外部签名参数。

安卓端最低系统版本为 Android 8.0（API 26），目标版本为 API 35。实际设备的通知、后台任务、系统文件选择器、蓝牙和校园网连接仍需要真机测试；源码能够构建不等于已验证所有机型与网络。
