# HDD

**HDD** 是一个「Fairy」桌面终端：全屏窗口中，居中的 Fairy 吉祥物随对话自动切换状态，
下方是 CMD 式终端输入输出（无气泡、无提示文案），对话经 **DeepSeek API（`deepseek-v4-flash`，SSE 流式）** 驱动。
视觉资产提取自 Fairy-DSH-main（`dsh-fairy-visual` 插件），桌面壳为 Electron，纯本地页面（CSP 禁网）。

> 许可：Apache License 2.0，© 2026 Chengzhibense（见 `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md`）。
> “Fairy / DeepSeek / 相关游戏及商标”不属于本授权；本工程不含任何官方素材、游戏文本或私有语料。

---

## 1. 功能一览

- **全屏桌面终端**（标题 `HDD`），Esc 一键退出
- Fairy 严格居中，历史文本在升高接近中央时**渐隐消失**，永不遮挡吉祥物
- Fairy 回复**逐字打字机**输出；状态自动切换：
  - 空闲 = 常态
  - 模型推理（`reasoning_content` 流出）= 思考态
  - 正文回复（`content` 流出）= “说话”= 安慰态
  - 状态每次切换伴随**随机故障（glitch）视效**
- **终端式输入输出**：无气泡/无提示文字/无输入占位符；输入行随历史一起从底部向上生长
- **强制禁 Emoji**：system prompt 禁止 + 显示层 Unicode 清洗双保险
- **自我认知 = Fairy**：系统设定禁止自称 DeepSeek / OpenAI 等其它模型
- 字号 / 字重 / 栏宽均为 CSS 变量，可一键微调

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| OS | Windows x64（打包产物为 portable exe） |
| Node.js | ≥ 20（仅开发/打包需要；成品 exe 不依赖 Node） |
| 网络 | 运行期需可访问 `https://api.deepseek.com`（仅主进程发起） |
| 字体 | **需自备**（见 3.0）：把 `.ttf/.otf/.woff/.woff2` 放进 `app/fonts/` 即可，`prep` 会自动注册 |

## 3. 快速开始

### 3.0 放字体（可选，但强烈建议）

本仓库**不包含字体文件**（授权原因）。请自备中文字体，把文件放进 `app/fonts/`
目录，构建时 `scripts/prep.cjs` 会自动读取其族名与字重并生成 `@font-face`，
**无需修改任何配置**。

- 不放字体也能运行，界面会回退到系统字体（`Microsoft YaHei` / `Segoe UI`），
  只是失去原本的视觉效果；
- 若字体**只有单一字重**（如本工程原用的重黑体），请保持 `--fairy-weight: 400`
  与其一致；设成字体没有的字重会触发浏览器的「合成加粗」，中文会发糊。

### 3.1 配置 API Key（必做）

应用读取 `app/config.json`，环境变量可覆盖：

```jsonc
// app/config.json（模板见 app/config.example.json）
{
  "apiKey": "sk-…你的 DeepSeek API Key…",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com"
}
```

- `app/config.json` 已被 `.gitignore` 排除，请勿提交；
- 也可用环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` 覆盖（**环境变量优先于 config.json**）。
- **源码运行与打包运行读的是同一份 `config.json`，但打包时是它的快照**：
  用真实 Key 打包出来的 exe 是**私人版**，内含 Key，**不要外发**；
  要发布 demo，请先把 `app/config.json` 换成占位值再打包。
- **portable exe 不会读取 exe 旁边的 `config.json`**：portable 每次把自己解包到
  `%TEMP%` 运行，代码读的是解包目录里的那份。因此给已打包的 exe 配 Key 要用
  环境变量（`setx DEEPSEEK_API_KEY "sk-…"` 后重启进程），或重新打包。

### 3.2 开发运行

```sh
cd app
npm install            # 首次（下载 Electron ~120MB）
npm start              # = prep（生成 www/）后启动开发窗口
```

### 3.3 打包成品（portable 单 exe）

```sh
cd app
npm run dist           # 产出 app/dist/HDD-0.01.exe，双击即用
```

### 3.4 一键测试与资产重建（项目根目录）

```sh
npm run assets:bake    # 重新烘焙视觉资产并刷新 assets/MANIFEST.json
npm run app:test       # prep 后跑渲染层回归测试（jsdom）
npm test               # = assets:bake + app:test
npm run app:dist       # 同 3.3
```

## 4. 使用说明

1. 双击 `HDD-0.01.exe` → 全屏窗口：中央 Fairy，底部空白输入行（块状光标）
2. 输入文字按 **Enter** 发送（如 `你是谁`）；Fairy 先进入思考态（伴随故障闪烁），
   再以安慰态逐字打出回复，完成后回到常态
3. **Esc** 退出程序；点击任意文本区可让输入行重新获得焦点
4. 故障/闪烁仅为视觉表现，不影响对话

## 5. 项目结构

```
HDD/
├── README.md                  ← 本文档
├── package.json               ← 根聚合脚本（assets:bake / app:test / …）
├── LICENSE / NOTICE / THIRD_PARTY_NOTICES.md
├── MANIFEST.json              ← 资产清单：来源映射 + SHA-256（assets/bake.cjs 生成）
├── assets/                    ★ 可复用视觉资产层（与 App 解耦）
│   ├── bake.cjs               ← 资产烘焙器（SVG 落地 / CSS 抽取 / 配色 token / 清单）
│   ├── source/                ← 资产源模块（逐字复制自 Fairy-DSH-main，勿手改）
│   │   ├── mascot-geometry.js      眼睛几何参数
│   │   ├── mascot-eye-svg.js       主视觉 SVG（渐变/干扰滤镜/glitch 切片/眼睑 clip）
│   │   ├── mascot-effects-svg.js   光环 Halo + 睫毛脉冲 Pulse
│   │   ├── mascot-style.js         吉祥物动画/状态 CSS
│   │   └── esm/{constants.js, style.js, package.json}
│   │                              HDD 主题 CSS 注入源（149 KB）
│   ├── svg/                   ← 烘焙产物：fairy-eye(±thinking/comforting)/halo/pulse
│   ├── css/                   ← 抽取产物：fairy-mascot.css / fairy-hdd-theme.css
│   ├── tokens/                ← 配色/变量/字体统计（fairy-palette.json）
│   └── preview.html           ← 资产画廊（双击可在浏览器查看素材与色板）
└── app/                       ★ Electron 应用（消费 assets/ 生成 www/ 后打包）
    ├── package.json           ← 应用包：prep / icon / start / dist 脚本 + builder 配置
    ├── main.js                ← 主进程：全屏窗口、Esc 退出、DeepSeek SSE 代理（IPC）
    ├── preload.cjs            ← 安全桥：getConfig / ask / onStream（contextBridge）
    ├── config.json            ← 私密配置（Key/模型；gitignore）
    ├── config.example.json    ← 配置模板
    ├── fonts/                 ← 界面字体（**需自备**，本仓库不含；见 3.0）
    ├── build-res/             ← 应用图标（scripts/icon.cjs 生成 icon.png）
    ├── scripts/
    │   ├── prep.cjs           ← 组装 www/：注入 SVG + 复制 css/svg + 注册字体
    │   └── icon.cjs           ← 程序化生成 Fairy 眼图标（纯 Node 无依赖）
    ├── tests/renderer.test.cjs← jsdom 渲染层回归测试
    ├── src/live.template.html ← 界面模板（@@FAIRY_*@@ 由 prep 注入）
    ├── www/                   ← prep 生成（gitignore）
    └── dist/                  ← 打包产物：HDD-0.01.exe（gitignore）
```

### 分层设计（可扩展性）

| 层 | 职责 | 如何扩展 |
| --- | --- | --- |
| `assets/` | 视觉资产的“单一事实来源”：源模块 + 生成产物 + 清单 | 新增/修改资产 → 运行 `assets/bake.cjs` 重烘焙；加字体文件到 `app/fonts/` 即自动注册 |
| `app/` | 桌面应用：窗口/安全 IPC/页面/样式/打包 | 改页面模板 `app/src/live.template.html` 或主进程 `app/main.js`；跑 `prep` 后 `dist` |
| 渲染层 | 纯本地、无 Node、无外联（CSP `connect-src 'none'`） | API Key 只在主进程；渲染层仅通过 preload 桥收发消息 |

## 6. 技术要点

- **安全边界**：渲染进程 `sandbox + contextIsolation`，页面 CSP 禁网；模型请求只在主进程发起
- **流式状态机**：SSE 中 `delta.reasoning_content` → 思考态；`delta.content` → 说话（安慰态）
- **打字机**：内容逐字入队输出（队列过长自动提速），`done` 等待打完再收尾
- **禁 Emoji**：系统提示词 + 渲染层按 `Extended_Pictographic` 等范围二次清洗
- **字体**：需自备，放入 `app/fonts/`（原工程用的是内部族名为 `inpin hongmengti` 的重黑体）。微调见下节
- **居中与渐隐**：吉祥物固定 50%/50% + `translate(-50%,-50%)`，文本层 z=5、吉祥物 z=20，
  输出容器带中央径向 mask

## 7. 常用微调（都在 `app/src/live.template.html` 顶部 CSS）

| 想要的效果 | 改哪里 |
| --- | --- |
| 字号（28–32） | `body { --fairy-size: 30px; }` |
| 字重/粗细 | `--fairy-weight: 400`（**须与字体实际字重一致**，见 7.1；本字体仅 400 一个字重） |
| 栏宽 | `.line, #inputline { max-width: min(1500px, calc(100vw - 120px)); }` |
| 状态切换故障时长 | JS 中 `glitchFx(180 + Math.random() * 240)` |

> **关于文字描边**：曾试过两套方案，**均已移除**，现在 `.line` 与 `#term-input` 都是
> `text-shadow: none`，没有任何描边。
>
> - `-webkit-text-stroke` 是**居中描边**（轮廓内外各占一半），会啃掉字形；
> - 想只往外扩（真外描边），Chromium 的 `paint-order: stroke fill` **只对 SVG 文本生效**，
>   对 HTML 文本无效，只能用「8 向 `text-shadow` 偏移垫层」模拟。
>
> 移除的原因：本字体字面率高达 **88.2%**（雅黑 50.6%），笔画已达 **0.192 em**
> （Black/Heavy 级别），字内空白本就极窄；任何额外描边都是在往外加墨、进一步压窄
> 字怀，对可读性只有坏处。曾实测 8 向垫层的字面覆盖率增量：`0.5px → +15%`、
> `0.7px → +21%`、`1.0px → +30%`。**如需恢复，重新实现时请一并恢复对应测试断言。**

### 7.1 字重必须压过主题 CSS（重要，勿删）

`assets/css/fairy-hdd-theme.css`（从 Fairy-DSH 提取的资产）里有一条**全局规则**：

```css
html[data-dsh-fairy-visual] body,
html[data-dsh-fairy-visual] body :where(*) { font-weight: 800 !important }
```

它会命中终端里的**每一个元素**。而印品鸿蒙体**只有 400 一个字重**
（`usWeightClass=400`、无 `fvar` 可变轴），被强行设成 800 后 Chromium 只能走
**合成加粗（faux bold）**——把字形横向涂抹撑粗，中文本就笔画密集，细节因此**糊成一团**。

更隐蔽的是：`body` 上写的 `font-weight: var(--fairy-weight, 400)` 特异性只有 `(0,0,1)`，
**斗不过**上面那种写法，且 `--fairy-weight` 当时并未定义（`var()` 的 fallback 只在
变量「未定义」时生效，变量为空值时整条声明会被丢弃）——所以字重**一直实际是 800**。

因此 `app/src/live.template.html` 中保留了这段覆盖，**不要删除**：

```css
#hdd-root[data-dsh-fairy-visual] body #out,
#hdd-root[data-dsh-fairy-visual] body #out *,
/* … #log / #inputline / #term-input 同列 … */
{ font-weight: 400 !important }
```

要点：

- 靠 `<html id="hdd-root">` 把特异性抬到 `(1,1,n)` 级，稳定压过主题的 `(0,1,1)`；
- 必须覆盖 `#out` 的**全部后代**（主题的 `:where(*)` 就是命中每个元素）；
- 值用**字面量 400**，不要写成 `var(...)`：值含 `var()` 时部分 CSS 解析器
  （如 jsdom/cssstyle）会丢掉 `!important`，使这条覆盖静默失效；
- 文字颜色偏亮、字体又偏重，一旦字重被劫持为 800，观感会同时「变粗 + 变糊」，
  这两件事此前一直被误判为「字体设计问题」。

> 注：**jsdom 的 CSS 层叠按文档顺序决胜、忽略特异性**（实测：高特异性规则放在前面会输），
> 因此这条覆盖的**运行时效果无法用 jsdom 回归测试验证**，测试里只做存在性断言。
> 若日后更换主题 CSS，请在真实浏览器中重新核对字重。
> - 它不提升对比度（正文本就是亮色），价值在于文字滚过中央光晕/网格时轮廓更实。

## 8. 测试

```sh
# 渲染层回归（jsdom；覆盖：发送、思考/安慰状态、打字机、Emoji 清洗、布局断言、字重覆盖）
npm run app:test
```

测试不触网、不启动 Electron；`app/tests/renderer.test.cjs` 通过注入假 `fairyApp`
驱动完整「发送 → 推理 → 正文 → done」流程。布局断言的期望值是**当前**的遮罩写法
（`#out` 上的中央径向 `radial-gradient(ellipse 78vmin 58vmin at 50% 46% …)`），
改遮罩时需同步更新断言。

## 9. 常见问题

- **双击 exe 被 SmartScreen 拦截**：本地未签名程序，选「更多信息 → 仍要运行」。
- **回复报错/无输出**：先确认网络可达 `api.deepseek.com`、`config.json` 的 Key 有效；
  也可 `npm start` 看控制台。错误会以 `! …` 行打印在终端里。
- **界面字体未变化**：确认 `app/fonts/` 内 ttf 存在，重新 `npm run prep` 后 `dist`。
- **改 Key/模型**：编辑 `app/config.json`（或设环境变量）后重启；重新打包需再执行 `npm run dist`。
- **想换吉祥物/加字重**：见第 5 节分层设计说明。

## 10. 来源与致谢

- 视觉资产源自 **Fairy-DSH-main**（`dsh-fairy-visual`，Apache-2.0，© 2026 Chengzhibense）；
  原插件面向 DeepSeek Harness Web 客户端，本工程只提取视觉与工程实践，不包含其运行时。
- DeepSeek API 为本应用提供对话推理；`Fairy`、`HDD/Hollow Deep Drive` 等名称仅供本项目内的
  角色扮演用途，不暗示与相关方有任何官方关联。

_最后更新：结构重组为 HDD 后的根 README。_
