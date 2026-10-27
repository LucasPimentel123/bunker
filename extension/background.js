// User click only. No content scripts, website messaging, RPC or key handling.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
