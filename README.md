# FreeTV

用 Rust 和 Tauri 2 实现的电视直播客户端。Windows、macOS、Linux 和 Android 共用频道目录和设备端线路检测。桌面端在画面右侧选台，手机端在画面下方选台。

## 观看

打开客户端后选择频道或点击「播放直播」。可以按央视、卫视、国际筛选，在「国际」下输入国家中文名、英文名或两位代码，选择提示即可筛选；地方频道归入「国际 → 中国」，也可以搜索台名或地区、收藏频道。订阅首次载入后缓存在本机，部分订阅更新失败时沿用上一次成功的目录。上游没有条目时对应的分类为空。

「线路」可以检测当前频道或手动换线。内置检测最多同时发起 6 个请求，读取响应开头识别 HLS。地址可达与播放器实际起播分别记录，启动失败会依次尝试本频道的备用线路。上次实际起播成功的地址优先。打开「设置」可单独同步 Free-TV/IPTV 的全球列表、best-fan/iptv-sources 的央视和卫视列表，也可一键同步全部。界面显示每份列表的频道数、上次成功时间和错误。默认启动时自动同步缺失或超过 6 小时的列表；关闭自动同步后可直接浏览已有频道或手动更新。可按需单独启动或中止线路检测。播放依赖本地网络、区域限制以及系统 WebView 的媒体解码能力。支持 HLS 和 WebView 能解码的直接媒体文件。

### 多画面与画中画

点「全屏」可放大整个观看布局，在画面右上方选择「退出全屏」。Android 手机在电视直播和点播页点「全屏」会横屏播放，可向左右任一侧持机。点「退出全屏」或按系统返回键会恢复原来的方向设置；桌面也可按 Esc。

在直播页选择「双画面」或「四宫格」，点一个画面再从频道列表选台。带主声道标记的画面负责声音，播放、线路、收藏和画中画按钮也作用于这个画面。缩回单画面会保留当前选中的频道；切到全球电台会停止所有电视流。

所选视频开始播放后可点「画中画」。支持的 Android 8+ 设备可在其他应用上方继续看电视，点系统窗口可返回。桌面优先使用系统视频画中画，其他桌面 WebView 会切到可恢复的置顶小窗。多路直播的流畅度取决于设备解码能力和网络。

### 网络代理

在任一页面点击顶部的「设置」，可以管理电视频道、点播来源、网络代理和开源许可。默认使用系统网络。选择「自定义代理规则」，填写代理 URL，例如 `http://192.168.1.8:8080` 或 `socks5h://192.168.1.8:1080`。六个开关分别用于电视频道列表、电视播放与线路检测、电台目录、电台播放、点播订阅与搜索（含封面）、点播媒体播放。设置保存在本机，对下一次请求生效；切换频道会重新建立播放连接。手机填写电脑代理时使用电脑的局域网 IP，手机上的 127.0.0.1 指手机自身。HTTP(S) 支持 Basic 认证，SOCKS5(H) 支持用户名和密码认证。可以分开填写或粘贴带凭据的代理 URL。密码随设置以明文保存在本机应用配置文件中，重新打开设置时不会回显。

### 单条线路深度检测

打开「线路」，在目标线路旁点「深度检测」。Windows、macOS 和 Linux 自动在 PATH 中查找 FFmpeg，macOS 也检查 Homebrew 常用安装目录。在顶部「设置」的「电视频道」中，点「选择程序」可指定本机的 ffmpeg 或 ffmpeg.exe，选择会保存在本机。「恢复自动查找」会清除该选择。安装包不附带 FFmpeg，未安装时仍可快速检测和看电视。

Android 使用独立的静音播放器试播所选线路，取得第一帧后立即结束。桌面和手机都设置了 15 秒超时，结果显示在所选线路下方。深度检测只按需运行，不参与批量扫描。

首次安装附带频道、电台、点播源和精选点播条目的目录快照。首次打开即可浏览，联网时按现有设置更新目录，播放仍需连接节目来源。电视使用 Free-TV/IPTV 与 best-fan/iptv-sources，电台来自 Radio Browser，点播源来自 LunaTV，预置节目来自 Internet Archive、PeerTube 和内置影视接口。

### 影视点播

打开独立的「点播」标签，首页按电影、剧集、动画、纪录与档案等类别展示，搜索视频名称可跨源查找。PeerTube / Sepia Search 和 Internet Archive 默认启用。前者检索各 PeerTube 站点并从原站读取播放地址，后者在首页展示精选馆藏、搜索时检索公开的视频条目，播放可用的 MP4。「全部来源」汇总所有启用接口，也可指定单个来源。首次联网同步前使用内置接口，360 和 MediathekView 可按需启用。播放页支持选集、切换线路和同名影片来源。播放器记住最近观看的影片、集数和进度，影片可加入本机片单。切换到电视或电台时停止点播。

「设置 → 点播来源」可逐源启停、试播检测首帧、查看目录请求与实际播放结果、手动同步或添加在线订阅。默认首次打开点播时自动读取内置 LunaTV 点播源集合，以后打开时若距上次同步超过一天会再次更新。新发现的接口自动参与搜索，已关闭接口保持关闭，读取订阅失败时沿用上次清单。LibreTV、LunaTV、OuonnkiTV 和 TVBox 的 JSON 采集接口可导入。依赖 TVBox 插件的站点会跳过。片库和分集在浏览时向启用的源读取。公播节目可能有地域或授权期限限制。

### 全球电台

选择「全球电台」浏览 Radio Browser 的在线目录，或用台名、国家/地区（输入中文名、英文名或代码后从提示中选择）、语言与类型筛选。星标电台会保存在设备上；打开「电台收藏」即可再次收听。点击「停止」结束播放。直播地址和编码取决于电台。

Android 在原生 Media3 媒体播放前台服务中收听电台。锁屏或切到其他应用时，通知与系统媒体控件可暂停和继续播放。拔出耳机时自动暂停；应用被系统强行停止后，需重新打开播放。桌面端通过系统 WebView 播放。手动触发 Build FreeTV 时可勾选 Android 锁屏回归测试。

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

推送 main、v 开头的标签、提交 PR 或手动运行 **Build FreeTV** 会生成 Windows x64 NSIS 安装包、macOS Apple Silicon DMG、Linux x64 DEB 和 Android arm64 APK。安装包可在该次运行的 Artifacts 中下载，保留一天。版本标签构建成功后，工作流会创建仅提供源码的 GitHub Release 草稿，供核对后发布。Windows、macOS 使用未做发行者签名或公证的测试分发构建。Android 默认用此次 CI 的临时证书签名，不同运行的测试 APK 签名不同，如需覆盖更新需使用同一把密钥。可配置四个仓库 Secrets 启用固定发布签名：

- ANDROID_KEYSTORE_BASE64
- ANDROID_KEY_ALIAS
- ANDROID_KEY_PASSWORD
- ANDROID_STORE_PASSWORD

## 来源

- [Free-TV/IPTV](https://github.com/Free-TV/IPTV) 提供全球播放列表。
- [best-fan/iptv-sources](https://github.com/best-fan/iptv-sources) 提供央视与卫视播放列表。
- 检测逻辑适配自 [zhimin-dev/iptv-checker-rs](https://github.com/zhimin-dev/iptv-checker-rs/tree/b1febd5d5464a26ca6f476e16d4ecea76f063e84) 的 HLS 预检和格式识别，保留 [MIT 许可](licenses/iptv-checker-rs.txt)。客户端使用异步 Rust 网络请求，不需要另行部署 Docker。桌面端的可选首帧解码检测调用本机 FFmpeg。
- 封面照片来自 [Unsplash](https://images.unsplash.com/photo-1508804185872-d7badad00f7d)。实际直播画面由用户选择的上游提供。
