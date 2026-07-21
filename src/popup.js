const statusEl = document.getElementById('status');
const runEverythingButton = document.getElementById('run-everything');

const setStatus = (text) => {
  if (statusEl) {
    statusEl.textContent = text;
  }
};

const runEverything = () => {
  const label = '签到和打卡';
  setStatus(`正在准备${label}…`);
  chrome.runtime.sendMessage(ExtensionProtocol.createMessage(ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK, { action: 'everything' }), (response) => {
    if (chrome.runtime.lastError || !response?.ok) { setStatus(`${label}启动失败，请重试。`); return; }
    setStatus(`已开始${label}，页面加载后会自动执行。`);
    window.close();
  });
};

runEverythingButton?.addEventListener('click', runEverything);


document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.close();
  }
});

runEverythingButton?.focus();
