// Clicking the toolbar icon opens (or focuses) the recorder window.
const RECORDER_URL = chrome.runtime.getURL('recorder.html');

chrome.action.onClicked.addListener(async () => {
  const open = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [RECORDER_URL] });
  if (open.length) {
    await chrome.windows.update(open[0].windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url: RECORDER_URL, type: 'popup', width: 960, height: 740 });
});
