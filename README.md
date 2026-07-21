# 一亩三分地每日助手

这是一个 Manifest V3 Chrome 扩展，为一亩三分地的 `/next/daily-question` 和 `/next/daily-checkin` 页面提供本地学习与人工确认辅助。它不替用户绕过站点流程。

## 安装

1. 打开 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本项目目录。
3. 打开扩展弹窗。弹窗只提供“一键签到&打卡”操作按钮。扩展仅申请 `storage` 和 `notifications` 权限；`notifications` 仅用于签到完成后的系统通知。

安装后如果修改了源文件，请在 `chrome://extensions` 点击扩展的“重新加载”，再刷新答题页。

排错时必须在 `chrome://extensions` 加载或重新加载这个精确目录：`/Users/mingjie/Documents/github/personal-projects/chrome-ext/一亩三分地-ext/`。如果页面脚本 URL 是 `chrome-extension://.../build/content.js`，说明运行的仍是旧版或其他扩展，并不是本项目的 `src/content.js`。请停用/移除旧扩展后重新加载上述目录，再刷新页面。

扩展图标使用一亩三分地 favicon 的本地派生图，并叠加红色斜杠/断裂标记；图标文件位于 `assets/`，由 scaffold 检查确认 16/32/48/128 四种尺寸均存在。

## 使用流程

- 签到&打卡：点击弹窗唯一的“一键签到&打卡”后，扩展按“先签到、后答题”顺序在后台以 `active:false` 打开或复用目标标签页并执行安全的一键动作，不会切换用户当前的 active tab；当天已完成的阶段视为成功跳过，继续下一阶段。每个阶段都有独立 actionId，阶段失败、登录、验证码、超时、未识别或题库多候选会停止流程并保留页面提示。
- 签到成功反馈：页面会显示 3 秒 Toast，并发送一条系统通知。后台任务成功后会自动关闭目标标签页；用户当前正在使用的标签页不会关闭。
- 页面工具栏仍保留“一键答题”和“一键签到”（或兼容的确认按钮），方便单独操作；这些页面内动作不改变签到&打卡的顺序控制。
- 弹窗发起的一键任务在页面明确成功后会自动关闭其目标标签页；手动打开页面或使用页面工具栏动作不会自动关闭标签页。验证码、登录、超时或不确定结果会保留页面供用户处理。

## 题库与测试

题库是 `data/answer-bank.json`，由 `scripts/merge-bank.mjs` 根据脚本内来源生成；来源说明和许可证信息见 `data/SOURCES.md`。项目当前统计以 `data/merge-report.json` 为准：10 个成功来源、1304 条 raw records、198 个 normalized entries、11 个 ambiguous entries、4 个 cross-source conflicts。更新题库后应同时检查该 report 和来源文件。

运行全部静态测试：

```sh
for file in scripts/test-*.mjs; do node "$file"; done
find src scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
```

第二条命令在 macOS zsh 下使用 NUL 分隔文件名，覆盖 `src` 与 `scripts` 中实际存在的 `.js` 和 `.mjs` 文件。

本地也可单独运行 `node scripts/check-scaffold.mjs` 和 `node scripts/test-ui-docs.mjs`。

## 学习层、隐私与来源边界

学习答案只存本机 `chrome.storage.local`，不上传账号数据；扩展不接入 AI、不保存 Cookie、不调用旧 Firebase，也不使用远程服务、`webRequest` 或额外权限。`notifications` 仅用于签到完成后的系统通知。题库来源文件可能没有统一许可证；除来源明确许可外，题库及派生数据仅作个人本地使用，请勿再分发，并自行遵守原项目许可证和站点条款。

扩展不绕过验证码或登录，不伪造站点请求，不模拟隐藏 API；提交动作通过可见页面控件并要求用户确认。

## 已知限制

扩展依赖官网当前 DOM、按钮文字和页面路径。官网改版、登录状态变化、验证码或异步渲染可能导致无法识别、无法准备或需要手动操作；遇到这种情况请刷新页面并按站点流程完成操作。
