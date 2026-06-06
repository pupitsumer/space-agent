const MODULE_MAX_LAYER_META_NAME = "space-max-layer";
const MODULE_PATH_PREFIX = "/mod/";

let cachedModuleMaxLayer;

function parseOptionalMaxLayer(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return null;
  }

  return Math.min(2, Math.max(0, numericValue));
}

export function getConfiguredModuleMaxLayer() {
  if (cachedModuleMaxLayer !== undefined) {
    return cachedModuleMaxLayer;
  }

  const metaTag = document.querySelector(`meta[name="${MODULE_MAX_LAYER_META_NAME}"]`);
  cachedModuleMaxLayer = parseOptionalMaxLayer(metaTag?.content);
  return cachedModuleMaxLayer;
}

export function applyModuleResolution(value) {
  const originalValue = String(value || "");

  if (!originalValue) {
    return originalValue;
  }

  const maxLayer = getConfiguredModuleMaxLayer();
  const basePath = (typeof window !== "undefined" && window.__SPACE_BASE_PATH__) || "";

  if (maxLayer === null && !basePath) {
    return originalValue;
  }

  let resolvedUrl;

  try {
    resolvedUrl = new URL(originalValue, globalThis.location.origin);
  } catch {
    return originalValue;
  }

  if (
    resolvedUrl.origin !== globalThis.location.origin ||
    !resolvedUrl.pathname.startsWith(MODULE_PATH_PREFIX)
  ) {
    return originalValue;
  }

  if (maxLayer !== null) {
    resolvedUrl.searchParams.set("maxLayer", String(maxLayer));
  }

  if (originalValue.startsWith("/")) {
    return `${basePath}${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  }

  if (basePath) {
    resolvedUrl.pathname = basePath + resolvedUrl.pathname;
    return resolvedUrl.toString();
  }

  return resolvedUrl.toString();
}

export function applyModuleResolutionToElementAttributes(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return;
  }

  const candidates = root.matches?.("[href],[src],[path]")
    ? [root, ...root.querySelectorAll("[href],[src],[path]")]
    : root.querySelectorAll("[href],[src],[path]");

  for (const element of candidates) {
    for (const attributeName of ["href", "path", "src"]) {
      if (!element.hasAttribute?.(attributeName)) {
        continue;
      }

      element.setAttribute(
        attributeName,
        applyModuleResolution(element.getAttribute(attributeName))
      );
    }
  }
}
