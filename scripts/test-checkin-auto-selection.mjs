import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const checkin = source.slice(source.indexOf('let checkinPrepared'), source.indexOf('let timer;'));

assert.match(checkin, /let checkinAutoAttempt = null;/);
assert.match(checkin, /if \(state === 'requires-login'\) \{ checkinPrepared = null; checkinAutoAttempt = null;/);
assert.match(checkin, /if \(state === 'completed'\) \{ checkinPrepared = null; checkinAutoAttempt = null;/);
assert.match(checkin, /const defaultSignature = CheckinState\.nodeSignature\(defaultNode\);/);
assert.match(checkin, /if \(!checkinAutoAttempt\) \{[\s\S]*?defaultNode\.click\(\);[\s\S]*?CheckinState\.prepare\(defaultNode, location\.href\)/);
assert.match(checkin, /已自动选择：没心情，请检查后确认签到/);
assert.equal((checkin.match(/defaultNode\.click\(\)/g) || []).length, 1, 'automatic path has exactly one option click');
assert.equal((checkin.match(/submit\.click\(\)/g) || []).length, 2, 'submit clicks exist only in the two user confirmation handlers');
assert.match(checkin, /oneClick\.addEventListener\('click',[\s\S]*?DailyCheckinPage\.getState\(\)[\s\S]*?await waitForCheckinSubmit\(\)[\s\S]*?submit\.click\(\)/);
assert.match(checkin, /checkinActionKey/);
assert.match(checkin, /if \(!defaultNode\) \{ checkinPrepared = null;[\s\S]*?return; \}/);
assert.match(checkin, /CheckinState\.reconcile\(checkinPrepared, location\.href, defaultNode\)/);
console.log('checkin auto-selection tests passed.');
