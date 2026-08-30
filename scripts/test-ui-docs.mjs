#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const popup = read('src/popup.html');
const popupJs = read('src/popup.js');
const css = read('src/content.css');
const readme = read('README.md');
const report = JSON.parse(read('data/merge-report.json'));

assert.match(manifest.name, /[一-鿿]/);
assert.match(manifest.description, /[一-鿿]/);
assert.match(manifest.action.default_title, /[一-鿿]/);
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage', 'notifications', 'alarms']);
assert.deepEqual(manifest.host_permissions, [
  'https://1point3acres.com/*',
  'https://www.1point3acres.com/*',
]);
assert.match(popup, /<html lang="zh-CN">/);
assert.match(popup, /id="run-everything"/);
assert.match(popup, /id="run-checkin"/);
assert.match(popup, /id="run-question"/);
assert.match(popup, /id="alert-banner"/);
assert.doesNotMatch(popup, /打开每日答题|打开每日签到|open-question|open-checkin/);
assert.doesNotMatch(popupJs, /openPage|window\.open|无法打开/);
assert.match(readme, /10 个成功来源、1304 条 raw records、198 个 normalized entries、11 个 ambiguous entries、4 个 cross-source conflicts/);
assert.match(readme, /不接入 AI/);
assert.match(readme, /不保存 Cookie/);
assert.match(readme, /不调用旧 Firebase/);
assert.match(readme, /不绕过验证码或登录/);
assert.match(readme, /不伪造站点请求/);
assert.match(readme, /仅作个人本地使用/);
assert.match(readme, /申请 `storage`、`notifications` 和 `alarms` 权限/);
assert.match(readme, /已签到.*继续答题/);
assert.match(readme, /已答题.*视为完成/);
assert.match(readme, /未登录：[\s\S]*验证码：[\s\S]*题库未收录：[\s\S]*多候选：/);
assert.match(readme, /登录暂停会在用户完成登录后继续恢复/);
assert.doesNotMatch(readme, /扩展只申请 `storage` 权限/);
assert.match(readme, /后台 workflow 自动打开或复用目标标签页/);
assert.match(readme, /显示 3 秒 Toast/);
assert.match(readme, /发送一条系统通知/);
assert.match(readme, /自动关闭目标标签页/);
assert.match(readme, /手动打开且未通过一键 workflow 管理的页面不会被关闭/);
assert.match(readme, /一键 workflow[\s\S]{0,200}复用/);
assert.doesNotMatch(readme, /popup 复用的用户 tab，不会因为操作完成而自动关闭 tab/);
assert(readme.includes("find src scripts -type f \\( -name '*.js' -o -name '*.mjs' \\) -print0 | xargs -0 -n1 node --check"), 'README must document the portable src/scripts node --check command');
assert.match(readme, /macOS zsh/);
assert.match(readme, /覆盖 `src` 与 `scripts` 中实际存在的 `\.js` 和 `\.mjs` 文件/);
assert.doesNotMatch(readme, /src\/scripts\/\*\.js/);
assert.match(readme, new RegExp(`${report.successfulSources} 个成功来源`));
assert.match(readme, new RegExp(`${report.rawRecordCount} 条 raw records`));
assert.match(readme, new RegExp(`${report.normalizedEntryCount} 个 normalized entries`));
assert.match(readme, new RegExp(`${report.ambiguousEntryCount} 个 ambiguous entries`));
assert.match(readme, new RegExp(`${report.conflictCount} 个 cross-source conflicts`));
for (const id of ['p3a-daily-question-helper', 'p3a-daily-checkin-helper']) assert.match(css, new RegExp(`#${id}`));
assert.match(css, /min-(?:width|height):\s*44px/);
assert.match(css, /:disabled/);
assert.match(css, /:focus-visible/);
assert.match(css, /prefers-color-scheme:\s*dark/);
assert.match(css, /color-scheme:\s*dark/);
console.log('UI and documentation tests passed.');
