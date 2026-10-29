// Clicking the toolbar icon opens the board, or brings back the tab it is already in.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("board.html");
  const [open] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
