import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/shared/daily-checkin-page.js', import.meta.url), 'utf8');
const make = (html, url = 'https://www.1point3acres.com/next/daily-checkin') => {
  const nodes = [];
  const parse = (tag, attrs, body) => {
    const map = Object.fromEntries([...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? '']));
    const n = { textContent: body, hidden: false, disabled: Object.prototype.hasOwnProperty.call(map, 'disabled'), checked: Object.prototype.hasOwnProperty.call(map, 'checked'), className: map.class || '', ownerDocument: null, attributes: map, getAttribute(k) { return this.attributes[k] ?? null; }, querySelector() { return null; }, matches() { return false; }, closest() { return null; } };
    nodes.push(n); return n;
  };
  const body = { textContent: html.replace(/<[^>]+>/g, ' '), innerText: html.replace(/<[^>]+>/g, ' ') };
  const document = { body, defaultView: null, querySelectorAll(selector) { return nodes.filter((n) => selector.includes(n.tag) || selector.includes('[role=')); } };
  html.replace(/<(button|input|label)([^>]*)>([^<]*)<\/\1>/gi, (_, tag, attrs, bodyText) => { const n = parse(tag, attrs, bodyText); n.tag = tag; n.ownerDocument = document; return _; });
  for (const n of nodes) { n.closest = (sel) => sel.includes('p3a-daily-checkin-helper') ? null : null; }
  const sandbox = { location: { href: url }, document, globalThis: null }; sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox); return { api: sandbox.DailyCheckinPage, document, nodes };
};

assert.equal(make('', 'https://www.1point3acres.com/next/daily-checkin/?foo=1').api.isCheckinPage(), true);
let x = make('<button>搜索</button><button>登录</button><button data-value="x">只想签到拿米</button><textarea></textarea><button>签到</button>');
assert.equal(x.api.getState(x.document), 'active'); assert(x.api.findDefault(x.document)); assert(x.api.findSubmit(x.document));
x = make('<button>每日签到</button><button>签到记录</button><button>签到规则</button><button>帮助</button><button>已签到</button>');
assert.equal(x.api.findSubmit(x.document), null);
x = make('<button>确认签到</button>'); assert(x.api.findSubmit(x.document));
x = make('<button>提交签到</button>'); assert(x.api.findSubmit(x.document));
x = make('<input type="submit" value="提交签到"></input>'); assert(x.api.findSubmit(x.document));
x = make('<button>请先登录</button>'); assert.equal(x.api.getState(x.document), 'requires-login');
x = make('<div>今日已签到</div>'); assert.equal(x.api.getState(x.document), 'completed');
x = make('<main><button>没心情</button><div>恭喜你签到成功!获得奖励 大米 1 升</div></main>'); assert.equal(x.api.getState(x.document), 'completed');
x = make('<main><button>没心情</button></main><div>恭喜你签到成功!获得奖励 大米 1 升</div>'); assert.equal(x.api.getState(x.document), 'completed');
x = make('<main><button disabled>今日已签到</button><div>您累计已签到 200 天</div></main>'); assert.equal(x.api.getState(x.document), 'completed');
x = make('<main><div>您累计已签到 200 天</div></main>'); assert.equal(x.api.getState(x.document), 'active');
x = make('<button>心情很好</button><textarea></textarea>'); assert.equal(x.api.findDefault(x.document), null);
x = make('<button class="hover:bg-primary-light rounded-md border hover:cursor-pointer">X 没心情</button>'); assert(x.api.findDefault(x.document));
x = make('<button class="hover:bg-primary-light rounded-md border hover:cursor-pointer">其他心情</button>'); assert.equal(x.api.findDefault(x.document), null);
x = make('<input name="qdxq" value="x"></input>'); assert(x.api.findDefault(x.document));
x = make('<button aria-checked="true">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'aria-checked default mood must count as selected');
x = make('<button>没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), false, 'unselected default mood must not count as selected');
x = make('<button aria-pressed="true">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'aria-pressed default mood must count as selected');
x = make('<button data-state="selected">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'data-state=selected must count as selected');
x = make('<button data-state="CHECKED">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'data-state must match selected|checked|on case-insensitively');
x = make('<button data-state="on">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'data-state=on must count as selected');
x = make('<button data-active="true">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'data-active=true must count as selected');
x = make('<button class="rounded-md ring-2 text-sm">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), false, 'ring-2 focus ring must not count as selected');
x = make('<button class="rounded-md ring-primary text-sm">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'ring-primary class token must count as selected');
x = make('<button class="rounded-md border-primary text-sm">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'border-primary class token must count as selected');
x = make('<button class="hover:bg-primary-light rounded-md border hover:cursor-pointer">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), false, 'hover:bg-primary-light must not count as selected');
x = make('<button class="hover:bg-primary rounded-md">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), false, 'hover:bg-primary must not count as selected');
x = make('<button class="hover:border-primary rounded-md">没心情</button>');
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), false, 'hover:border-primary must not count as selected');
x = make('<button>没心情</button>');
x.api.findDefault(x.document).querySelector = (sel) => String(sel).includes('input') ? { checked: true } : null;
assert.equal(x.api.isDefaultSelected(x.api.findDefault(x.document)), true, 'nested checked input must count as selected');
x = make('<button>没心情</button>');
{
  const mood = x.api.findDefault(x.document);
  mood.querySelector = () => null;
  mood.closest = (sel) => String(sel).includes('label') ? { querySelector: (s) => String(s).includes('input') ? { checked: true } : null } : null;
  assert.equal(x.api.isDefaultSelected(mood), true, 'checked input in closest label must count as selected');
}
console.log('daily checkin page tests passed.');
