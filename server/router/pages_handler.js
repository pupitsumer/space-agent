import fs from "node:fs/promises";
import path from "node:path";

import { areGuestUsersAllowed, getBasePath, isSingleUserApp } from "../lib/utils/runtime_params.js";
import { runTrackedMutation } from "../runtime/request_mutations.js";
import { createNoStoreHeaders, sendFile, sendJson, sendNotFound, sendRedirect } from "./responses.js";

const LEGACY_ROUTE_REDIRECTS = new Map([
  ["/index.html", "/"],
  ["/login.html", "/login"],
  ["/enter.html", "/enter"],
  ["/admin.html", "/admin"]
]);

const LOGOUT_ROUTE = "/logout";
const PAGE_RESOURCE_PREFIX = "/pages/res/";
const ROOT_PAGE_RESOURCE_ALIASES = new Map([
  ["/favicon.ico", "/res/favicon.ico"],
  ["/favicon-16x16.png", "/res/favicon-16x16.png"],
  ["/favicon-32x32.png", "/res/favicon-32x32.png"],
  ["/apple-touch-icon.png", "/res/apple-touch-icon.png"],
  ["/android-chrome-192x192.png", "/res/android-chrome-192x192.png"],
  ["/android-chrome-512x512.png", "/res/android-chrome-512x512.png"],
  ["/site.webmanifest", "/res/site.webmanifest"],
  ["/robots.txt", "/robots.txt"],
  ["/llms.txt", "/llms.txt"],
  ["/llms-full.txt", "/llms-full.txt"],
  ["/sitemap.xml", "/sitemap.xml"]
]);
const FRONTEND_CONFIG_META_NAME = "space-config";
const ENTER_GUARD_PLACEHOLDER = "<!-- SPACE_SINGLE_USER_ENTER_GUARD -->";
const ENTER_GUARD_SCRIPT_TAG = '    <script src="/pages/res/enter-guard.js"></script>';
const PROJECT_VERSION_PLACEHOLDER = "<!-- SPACE_PROJECT_VERSION -->";
const SHARE_SPACE_ROUTE_PATTERN = /^\/share\/space\/([A-Za-z0-9]{8})$/u;

function buildBasePathPolyfill(basePath) {
  return `<script>
(function(){
  var BASE="${basePath}";
  window.__SPACE_BASE_PATH__=BASE;
  var _fetch=window.fetch.bind(window);
  function needsPrefix(p){return typeof p==="string"&&p.startsWith("/")&&p!==BASE&&!p.startsWith(BASE+"/");}
  window.fetch=function(input,init){
    if(typeof input==="string"&&needsPrefix(input)){return _fetch(BASE+input,init);}
    if(input instanceof URL&&input.origin===window.location.origin&&needsPrefix(input.pathname)){
      var u=new URL(input.href);u.pathname=BASE+input.pathname;return _fetch(u,init);
    }
    return _fetch(input,init);
  };
  function fixUrl(url){
    if(typeof url!=="string")return null;
    try{var u=new URL(url);if(u.origin===location.origin&&needsPrefix(u.pathname))return BASE+u.pathname+u.search+u.hash;}
    catch(e){if(needsPrefix(url))return BASE+url;}
    return null;
  }
  function fixDomNode(n){
    if(!n||n.nodeType!==1)return;
    var t=n.tagName.toLowerCase();
    try{
      if((t==="link"||t==="a")&&n.href){var f=fixUrl(n.href);if(f)n.href=f;}
      if((t==="script"||t==="img"||t==="video"||t==="source")&&n.src){var f=fixUrl(n.src);if(f)n.src=f;}
    }catch(e){}
    var ch=n.children;for(var i=0;i<ch.length;i++)fixDomNode(ch[i]);
  }
  var _ac=Node.prototype.appendChild;
  Node.prototype.appendChild=function(c){fixDomNode(c);return _ac.call(this,c);};
  var _ib=Node.prototype.insertBefore;
  Node.prototype.insertBefore=function(c,r){fixDomNode(c);return _ib.call(this,c,r);};
  var _sa=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,val){
    if((name==="href"||name==="src")&&typeof val==="string"){var f=fixUrl(val);if(f)val=f;}
    return _sa.call(this,name,val);
  };
  var _replace=Location.prototype.replace;
  Location.prototype.replace=function(url){
    if(needsPrefix(url))url=BASE+url;
    return _replace.call(this,url);
  };
  var _assign=Location.prototype.assign;
  Location.prototype.assign=function(url){
    if(needsPrefix(url))url=BASE+url;
    return _assign.call(this,url);
  };
})();
</script>
<script type="importmap">{"imports":{"/pages/res/":"${basePath}/pages/res/","/mod/":"${basePath}/mod/"}}</script>`;
}

function injectBasePath(sourceText, basePath) {
  if (!basePath) return sourceText;
  const polyfill = buildBasePathPolyfill(basePath);
  let result = sourceText
    .replace(/(<head[^>]*>)/iu, `$1\n${polyfill}`)
    .replace(/((?:href|src|action)=")\/(?!\/)/gu, `$1${basePath}/`)
    .replace(/((?:href|src|action)=')\/(?!\/)/gu, `$1${basePath}/`);
  return result;
}

function prefixRedirect(path, basePath) {
  if (!basePath || path.startsWith(basePath)) return path;
  return `${basePath}${path}`;
}

function createSessionCleanupHeaders(requestContext, auth) {
  if (
    requestContext?.user?.shouldClearSessionCookie &&
    auth &&
    typeof auth.createClearedSessionCookieHeader === "function"
  ) {
    return {
      "Set-Cookie": auth.createClearedSessionCookieHeader()
    };
  }

  return {};
}

function createClearedSessionHeaders(auth) {
  if (auth && typeof auth.createClearedSessionCookieHeader === "function") {
    return {
      "Set-Cookie": auth.createClearedSessionCookieHeader()
    };
  }

  return {};
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function buildFrontendConfigMetaTags(runtimeParams) {
  const entries =
    runtimeParams && typeof runtimeParams.listFrontendExposed === "function"
      ? runtimeParams.listFrontendExposed()
      : [];

  if (entries.length === 0) {
    return "";
  }

  return entries
    .map(
      (entry) =>
        `    <meta name="${FRONTEND_CONFIG_META_NAME}" data-space-param="${escapeHtmlAttribute(entry.name)}" data-space-type="${escapeHtmlAttribute(entry.type)}" content="${escapeHtmlAttribute(entry.content)}" />`
    )
    .join("\n");
}

function injectFrontendConfigMetaTags(sourceText, runtimeParams) {
  const metaTags = buildFrontendConfigMetaTags(runtimeParams);

  if (!metaTags) {
    return sourceText;
  }

  if (/<\/head>/iu.test(sourceText)) {
    return sourceText.replace(/<\/head>/iu, `${metaTags}\n  </head>`);
  }

  return `${metaTags}\n${sourceText}`;
}

function hasEnterLauncherAccess(requestContext, runtimeParams) {
  return Boolean(requestContext?.user?.isAuthenticated) || isSingleUserApp(runtimeParams);
}

function injectEnterGuard(sourceText, options = {}) {
  const pageName = String(options.pageName || "");

  if (!sourceText.includes(ENTER_GUARD_PLACEHOLDER)) {
    return sourceText;
  }

  if (
    !["index.html", "admin.html"].includes(pageName) ||
    !hasEnterLauncherAccess(options.requestContext, options.runtimeParams)
  ) {
    return sourceText.replace(ENTER_GUARD_PLACEHOLDER, "");
  }

  return sourceText.replace(ENTER_GUARD_PLACEHOLDER, ENTER_GUARD_SCRIPT_TAG);
}

function injectProjectVersion(sourceText, projectVersion) {
  if (!sourceText.includes(PROJECT_VERSION_PLACEHOLDER)) {
    return sourceText;
  }

  return sourceText.replaceAll(
    PROJECT_VERSION_PLACEHOLDER,
    escapeHtmlAttribute(projectVersion || "unknown")
  );
}

async function sendPageHtml(res, filePath, options = {}) {
  let sourceText;

  try {
    sourceText = await fs.readFile(filePath, "utf8");
  } catch {
    sendNotFound(res, options.headers);
    return;
  }

  const basePath = getBasePath(options.runtimeParams);
  const body = injectBasePath(
    injectFrontendConfigMetaTags(
      injectProjectVersion(
        injectEnterGuard(sourceText, {
          pageName: options.pageName,
          requestContext: options.requestContext,
          runtimeParams: options.runtimeParams
        }),
        options.projectVersion
      ),
      options.runtimeParams
    ),
    basePath
  );

  res.writeHead(200, createNoStoreHeaders({
    ...(options.headers || {}),
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/html; charset=utf-8"
  }));
  res.end(body);
}

async function handleLogoutRequest(res, options = {}) {
  const { auth, requestContext, runtimeParams } = options;

  try {
    if (
      requestContext?.user?.isAuthenticated &&
      auth &&
      typeof auth.revokeSession === "function"
    ) {
      await runTrackedMutation(options, async () =>
        auth.revokeSession(requestContext.user.sessionToken, requestContext.user.username)
      );
    }
  } catch {
    sendJson(res, 500, {
      error: "Internal server error"
    });
    return;
  }

  sendRedirect(res, prefixRedirect("/login", getBasePath(runtimeParams)), createClearedSessionHeaders(auth));
}

function resolvePathWithinRoot(rootDir, requestPath) {
  const filePath = path.resolve(rootDir, `.${requestPath}`);
  const relativePath = path.relative(rootDir, filePath);

  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return filePath;
}

function resolveSharePageRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (normalizedPath !== "/" && normalizedPath.endsWith("/")) {
    const trimmedPath = normalizedPath.slice(0, -1);

    if (SHARE_SPACE_ROUTE_PATTERN.test(trimmedPath)) {
      return {
        kind: "redirect",
        location: trimmedPath
      };
    }
  }

  if (!SHARE_SPACE_ROUTE_PATTERN.test(normalizedPath)) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, "/share_space.html"),
    kind: "file",
    pageName: "share_space.html"
  };
}

function resolvePageRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (LEGACY_ROUTE_REDIRECTS.has(normalizedPath)) {
    return {
      kind: "redirect",
      location: LEGACY_ROUTE_REDIRECTS.get(normalizedPath)
    };
  }

  if (normalizedPath !== "/" && normalizedPath.endsWith("/")) {
    return {
      kind: "redirect",
      location: normalizedPath.slice(0, -1)
    };
  }

  const pageName =
    normalizedPath === "/"
      ? "index.html"
      : normalizedPath.match(/^\/([a-z0-9_-]+)$/i)?.[1]
        ? `${normalizedPath.slice(1)}.html`
        : "";

  if (!pageName) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, `/${pageName}`),
    kind: "file",
    pageName
  };
}

function resolvePageResourceRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (!normalizedPath.startsWith(PAGE_RESOURCE_PREFIX)) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, normalizedPath.slice("/pages".length)),
    kind: "resource"
  };
}

function resolveRootPageResourceRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");
  const aliasedPath = ROOT_PAGE_RESOURCE_ALIASES.get(normalizedPath);

  if (!aliasedPath) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, aliasedPath),
    kind: "resource"
  };
}

async function handlePageRequest(res, requestUrl, options = {}) {
  const { auth, pagesDir, requestContext, runtimeParams } = options;
  const basePath = getBasePath(runtimeParams);

  if (requestUrl.pathname === LOGOUT_ROUTE) {
    await handleLogoutRequest(res, options);
    return;
  }

  const pageResourceRequest = resolvePageResourceRequest(pagesDir, requestUrl.pathname);
  const rootPageResourceRequest = resolveRootPageResourceRequest(pagesDir, requestUrl.pathname);
  const resourceRequest = pageResourceRequest || rootPageResourceRequest;

  if (resourceRequest) {
    if (!resourceRequest.filePath) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    sendFile(res, resourceRequest.filePath, {
      headers: createNoStoreHeaders(createSessionCleanupHeaders(requestContext, auth))
    });
    return;
  }

  const sharePageRequest = resolveSharePageRequest(pagesDir, requestUrl.pathname);

  if (sharePageRequest) {
    if (sharePageRequest.kind === "redirect") {
      sendRedirect(res, prefixRedirect(sharePageRequest.location, basePath), createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    if (!areGuestUsersAllowed(runtimeParams)) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    if (!sharePageRequest.filePath) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    await sendPageHtml(res, sharePageRequest.filePath, {
      headers: createSessionCleanupHeaders(requestContext, auth),
      pageName: sharePageRequest.pageName,
      projectVersion: options.projectVersion,
      requestContext,
      runtimeParams
    });
    return;
  }

  const pageRequest = resolvePageRequest(pagesDir, requestUrl.pathname);

  if (!pageRequest) {
    sendNotFound(res);
    return;
  }

  if (pageRequest.kind === "redirect") {
    sendRedirect(res, prefixRedirect(pageRequest.location, basePath), createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  const isLoginPage = pageRequest.pageName === "login.html";
  const isEnterPage = pageRequest.pageName === "enter.html";
  const isAdminPage = pageRequest.pageName === "admin.html";
  const canAccessEnterPage = hasEnterLauncherAccess(requestContext, runtimeParams);

  if (isAdminPage) {
    const fallback = requestContext?.user?.isAuthenticated ? "/" : "/login";
    sendRedirect(res, prefixRedirect(fallback, basePath), createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (isEnterPage && !canAccessEnterPage) {
    sendRedirect(res, prefixRedirect("/login", basePath), createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (isLoginPage && requestContext?.user?.isAuthenticated) {
    sendRedirect(res, prefixRedirect("/", basePath), createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (!isLoginPage && !isEnterPage && !requestContext?.user?.isAuthenticated) {
    sendRedirect(res, prefixRedirect("/login", basePath), createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (!pageRequest.filePath) {
    sendNotFound(res);
    return;
  }

  await sendPageHtml(res, pageRequest.filePath, {
    headers: createSessionCleanupHeaders(requestContext, auth),
    pageName: pageRequest.pageName,
    projectVersion: options.projectVersion,
    requestContext,
    runtimeParams
  });
}

export { handlePageRequest };
