# Chrome Web Store listing copy

Dashboard 填写底稿。语言：Chinese (China)。类别：Tools（商店没有单独的 Productivity 选项）。Mature：不勾。

Summary（来自 `manifest.json` 的 `description`，控制台不可改，上限 132 字）：

```
帮助你完成一亩三分地的每日签到和每日答题。
```

Homepage / Support：`https://github.com/wangm12/1point3acres-plugin`

商店图标：`assets/1point3acres-helper-icon-128.png`（也可使用 `docs/store/icon-128.png` 副本）

截图（1280x800）：

- `docs/store/screenshot-popup.png`
- `docs/store/screenshot-popup-completed.png`
- `docs/store/screenshot-answer.png`
- `docs/store/screenshot-checkin.png`

小宣传图：`docs/store/promo-440x280.png`

隐私政策 URL（当前公网可打开）：`https://gist.github.com/wangm12/a72729ba999df6405ab738b45a74a2c6`

仓库内页面：`docs/privacy.html`。GitHub Pages 尚未开启；推送并开启后可改用 `https://wangm12.github.io/1point3acres-plugin/privacy.html`。

## Store listing 详细描述

对标商店里的「一亩三分地每日答题助手」：一句功能 + 一段怎么用，不写长边界清单。

```
帮助你完成一亩三分地的每日签到和每日答题。非官方本机辅助。

点扩展图标即可一键签到 & 答题，也可单独做其中一项。题库命中时自动提交；未登录、验证码或题目未收录时会停住等你处理。答案只保存在本机。
```

## Privacy · 单一用途

```
仅为一亩三分地每日签到页和每日答题页提供本机辅助：识别页面状态，在已登录且条件明确时辅助完成签到或答题，并把用户确认过的答案保存在本机。
```

## Privacy · 权限理由

```
storage：保存用户本机学习的答案、当日签到/答题进度，以及用户已配置的本地调度状态。数据不离开本机。

notifications：签到成功或整次「一键签到 & 答题」完成后，发送一条桌面通知。

alarms：在 service worker 被挂起后唤醒以收尾任务结果；仅当用户已配置本地调度时用于定时提醒，不会在未配置时自行创建任务。

https://1point3acres.com/*：打开、核验并在成功后关闭签到/答题任务标签页，并仅在 /next/daily-checkin 与 /next/daily-question 注入辅助界面。

https://www.1point3acres.com/*：同上，覆盖 www 子域。站点主站实际使用 www。
```

## Privacy · Remote code

选 **No, I am not using remote code.**

包内读取 `data/answer-bank.json` 不算远程代码。

## Privacy · 数据勾选

- 勾选 Website content（内容脚本读取题目、选项、签到状态）。
- 不要勾选个人身份、财务、健康、认证信息、通讯、位置、网页历史。
- Limited Use 认证全部勾选。
- 隐私政策 URL 必须与本页及 `docs/privacy.html` 一致。

## Distribution

- Visibility：Public
- 付费：免费
- 地区：按控制台默认或实际用户地区
- 提交确认框：取消「审核通过后立即发布」（deferred）。不要代点 Submit。

## Test instructions

```
本扩展只在用户已登录 1point3acres 后完整工作。未提供专用审核账号，请使用审核员自己的 1point3acres 登录态，或先在 https://www.1point3acres.com 登录后再测。

步骤：
1. 安装扩展。
2. 登录 https://www.1point3acres.com。
3. 点击扩展图标，按「一键签到 & 答题」。
4. 预期：自动打开签到页，默认选择「没心情」并提交；再打开答题页。题库唯一命中时自动提交；未命中或多候选时不提交、不关标签页。
5. 全部成功后，popup 显示今日进度已完成，并可能出现桌面通知。
6. 未登录时：不自动提交，保留页面。
7. 若账号当天已签到/已答题：应显示已完成，不会重复提交。站点每天各限一次，无法反复演示「从未完成」路径。
8. 扩展不绕过验证码。若站点弹出验证码，页面会保留，需人工完成。
```
