# HDD v0.0.1 (demo)

Fairy 主题的桌面终端:全屏窗口,中央吉祥物随对话自动切换状态,下方是 CMD 式终端
输入输出。对话由 **DeepSeek API**(SSE 流式)驱动。

这是**第一个公开 demo**,用于展示外观与交互形态,功能尚不完整。

---

## 快速开始(用现成的 exe)

下载本页附件 **`HDD-0.01.exe`**(96.6 MB,portable 单文件,免安装,Windows x64)。

> ⚠️ **这个 exe 里没有 API Key。** 必须按下面第 2 步自己配置,否则启动后无法对话。

### 1. 运行

双击 `HDD-0.01.exe`。首次运行可能被 SmartScreen 拦截(本地未签名程序),
选「更多信息 → 仍要运行」。

- **Esc** 退出
- 在底部输入行输入文字,按 **Enter** 发送

### 2. 配置 API Key(必做)

portable exe **不会**读取 exe 旁边的 `config.json`(它每次把自己解包到 `%TEMP%`
运行)。所以请用环境变量:

```powershell
setx DEEPSEEK_API_KEY "sk-你的DeepSeek API Key"
```

执行后**重新打开**程序(已开着的窗口读不到新变量)。想换模型可另设:

```powershell
setx DEEPSEEK_MODEL "deepseek-v4-flash"
```

API Key 在 https://platform.deepseek.com 申请。

### 3. 字体(可选,但强烈建议)

**本仓库不包含字体文件**(授权原因)。不提供字体也能运行,界面会回退到系统字体
`Microsoft YaHei`,只是失去原本的视觉效果。

想还原原貌:自行获取中文字体,放进 `app/fonts/` 后重新构建即可,
`scripts/prep.cjs` 会自动读取字体族名与字重,**无需改任何配置**。

---

## 从源码运行

```sh
git clone https://github.com/KarinnKyou/Fairy.git
cd Fairy/app
npm install
copy config.example.json config.json   # 填入你的 apiKey
npm start
```

打包成 exe:

```sh
npm run dist     # -> app/dist/
```

---

## 当前状态与已知限制

- **仅 Windows x64**,portable 单文件
- 对话历史最多保留最近 30 条;上下文不跨会话保存
- 界面为全屏,无窗口模式;Esc 退出
- 无流式取消按钮(等待回复期间不能中断)
- 粗体/其他字重的字体未支持:请确保字体的字重与 `--fairy-weight` 一致,
  否则浏览器会「合成加粗」,中文会发糊

## 后续计划

`v0.1` → `v0.2` → … → `v1.0` 逐步迭代。当前为形态验证版。

## 许可与声明

- Apache License 2.0,© 2026 Chengzhibense(见 `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md`)
- 视觉资产提取自 **Fairy-DSH-main**(`dsh-fairy-visual` 插件),只提取视觉与工程实践,不含其运行时
- **本仓库不含任何字体文件、官方素材、游戏文本或私有语料**
- 「Fairy」「DeepSeek」等名称仅供本项目内的角色扮演用途,不暗示与相关方有任何官方关联
- 本 demo 的 exe **不含任何 API Key**,请自行配置;请勿将他人 Key 打包分发
