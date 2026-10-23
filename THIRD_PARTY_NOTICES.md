# 第三方组件与资源

本文件索引随源码保留的第三方许可，不替代原许可文本。项目自有代码和文档采用根目录的 [MIT 许可证](LICENSE)；以下组件仍遵循各自的使用与分发条款，项目许可证不替换其原有版权或许可声明。

| 组件 | 当前版本或来源 | 本地许可文本 |
| --- | --- | --- |
| QR Code Generator | Kazuhiko Arase，MIT | `QR-LICENSE.txt` |
| NanoHTTPD | 2.3.1，BSD 3-Clause | `android/lib/LICENSE-nanohttpd.md` |
| `@peculiar/x509` 及其打包依赖 | x509 2.2.0；各依赖版本见合并许可 | `vendor/THIRD-PARTY-LICENSES.txt` |
| PDF.js / `pdfjs-dist` | 6.4.299，Apache License 2.0 | `vendor/THIRD-PARTY-LICENSES.txt` |
| PDF.js 标准字体中的 Foxit/PDFium 字体 | 上游随附资源 | `vendor/standard_fonts/LICENSE_FOXIT` |
| PDF.js 标准字体中的 Liberation 字体 | 上游随附资源，许可含字体例外 | `vendor/standard_fonts/LICENSE_LIBERATION` |

`vendor/THIRD-PARTY-LICENSES.txt` 还包含 ASN.1 相关依赖、`tslib`、`tsyringe`、`reflect-metadata` 等组件的版权和许可。`vendor/versions.json` 记录打包组件的版本。

Windows 构建使用 Electron 与 electron-builder，资源生成使用对应构建依赖。锁文件记录准确版本；依赖安装包保留各自的许可。分发应用时还应保留 Electron/Chromium 的许可与第三方说明，以及发行包中其他随附组件的许可。

源码整理版使用项目内的通用几何图标，不包含个人提供的漫画图片。`android/res/raw/webview_trust_anchor.pem` 是公开证书资源，不是任何开发者的 APK 签名密钥。第三方原作者和权利人的署名是许可证所要求的信息，不应作为“个人信息清理”删除。
