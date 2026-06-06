const ENTER_PAGE_PATH = (window.__SPACE_BASE_PATH__ || "") + "/enter";
const ENTER_TAB_ACCESS_KEY = "space.enter.tab-access";

function buildCurrentPageTarget() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
}

function redirectToEnter() {
  const enterUrl = new URL(ENTER_PAGE_PATH, window.location.origin);
  enterUrl.searchParams.set("next", buildCurrentPageTarget());
  window.location.replace(enterUrl.href);
}

try {
  if (window.sessionStorage.getItem(ENTER_TAB_ACCESS_KEY) !== "1") {
    redirectToEnter();
  }
} catch {
  redirectToEnter();
}
