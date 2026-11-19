# FreeTV

用 Rust 和 Tauri 2 实现的电视直播客户端。Windows、macOS、Linux 和 Android 共用频道目录、XMLTV 节目单和设备端线路检测。桌面端左右布局，手机端横滑选台。

## 观看

打开客户端后选择频道或点击「播放直播」。可以按央视、卫视、地方、国际筛选，搜索台名或地区，收藏频道。节目时间按本地时区显示。订阅首次载入后缓存在本机，部分订阅更新失败时沿用上一次成功的目录。上游没有条目时对应的分类为空。

「线路」可以检测当前频道或手动换线。内置检测最多同时发起 6 个请求，读取响应开头识别 HLS。地址可达与播放器实际起播分别记录，启动失败会依次尝试本频道的备用线路。上次实际起播成功的地址优先。打开「频道订阅」可刷新列表并后台批量检测，也可中止检测。播放依赖本地网络、区域限制以及系统 WebView 的媒体解码能力。支持 HLS 和 WebView 能解码的直接媒体文件。

### 单条线路深度检测

打开「线路」，在目标线路旁点「深度检测」。Windows、macOS 和 Linux 自动在 PATH 中查找 FFmpeg，macOS 也检查 Homebrew 常用安装目录。可点「选择程序」指定本机的 ffmpeg 或 ffmpeg.exe，选择会保存在本机。「恢复自动查找」会清除该选择。安装包不附带 FFmpeg，未安装时仍可快速检测和看电视。

Android 使用独立的静音播放器试播所选线路，取得第一帧后立即结束。桌面和手机都设置了 15 秒超时，结果显示在所选线路下方。深度检测只按需运行，不参与批量扫描。

## 启动与打包

安装 Node.js 22.12+、Rust stable，以及目标平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。Linux 运行时需要 WebKitGTK 4.1 和支持 H.264/AAC 的 GStreamer 插件。

```sh
npm ci
npm run tauri -- dev
cargo test --locked -p freetv-core
npm run tauri -- build
```

Android 需配置 JDK、Android SDK/NDK 和 Rust Android target。运行 `npm run tauri -- android init` 后可通过 `npm run tauri -- android dev` 在设备或模拟器启动。构建使用 `npm run tauri -- android build --apk --target aarch64`。

## GitHub Actions

推送 main、v 开头的标签、提交 PR 或手动运行 **Build FreeTV** 会生成 Windows x64 NSIS 安装包、macOS Apple Silicon DMG、Linux x64 DEB 和 Android arm64 APK。在该次运行的 Artifacts 下载。版本标签构建成功后，工作流会将四个安装包附加到对应的 GitHub Release 草稿，供核对后发布。Windows、macOS 使用未做发行者签名或公证的测试分发构建。Android 默认用此次 CI 的临时证书签名，不同运行的测试 APK 签名不同，如需覆盖更新需使用同一把密钥。可配置四个仓库 Secrets 启用固定发布签名：

- ANDROID_KEYSTORE_BASE64
- ANDROID_KEY_ALIAS
- ANDROID_KEY_PASSWORD
- ANDROID_STORE_PASSWORD

## 来源

- [Free-TV/IPTV](https://github.com/Free-TV/IPTV) 提供全球播放列表。
- [best-fan/iptv-sources](https://github.com/best-fan/iptv-sources) 提供央视与卫视播放列表。
- 检测逻辑适配自 [zhimin-dev/iptv-checker-rs](https://github.com/zhimin-dev/iptv-checker-rs/tree/b1febd5d5464a26ca6f476e16d4ecea76f063e84) 的 HLS 预检和格式识别，保留 [MIT 许可](licenses/iptv-checker-rs.txt)。客户端使用异步 Rust 网络请求，不需要另行部署 Docker。桌面端的可选首帧解码检测调用本机 FFmpeg。
- [EPG.PW](https://epg.pw/) 提供地区 XMLTV 数据。节目覆盖和更新时间取决于来源。
- 封面照片来自 [Unsplash](https://images.unsplash.com/photo-1508804185872-d7badad00f7d)。实际直播画面由用户选择的上游提供。
