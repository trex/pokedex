import "/pokedex/node_modules/vite/dist/client/env.mjs";

class HMRContext {
  constructor(hmrClient, ownerPath) {
    this.hmrClient = hmrClient;
    this.ownerPath = ownerPath;
    if (!hmrClient.dataMap.has(ownerPath)) {
      hmrClient.dataMap.set(ownerPath, {});
    }
    const mod = hmrClient.hotModulesMap.get(ownerPath);
    if (mod) {
      mod.callbacks = [];
    }
    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath);
    if (staleListeners) {
      for (const [event, staleFns] of staleListeners) {
        const listeners = hmrClient.customListenersMap.get(event);
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            listeners.filter((l) => !staleFns.includes(l))
          );
        }
      }
    }
    this.newListeners = /* @__PURE__ */ new Map();
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners);
  }
  get data() {
    return this.hmrClient.dataMap.get(this.ownerPath);
  }
  accept(deps, callback) {
    if (typeof deps === "function" || !deps) {
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod));
    } else if (typeof deps === "string") {
      this.acceptDeps([deps], ([mod]) => callback?.(mod));
    } else if (Array.isArray(deps)) {
      this.acceptDeps(deps, callback);
    } else {
      throw new Error(`invalid hot.accept() usage.`);
    }
  }
  // export names (first arg) are irrelevant on the client side, they're
  // extracted in the server for propagation
  acceptExports(_, callback) {
    this.acceptDeps([this.ownerPath], ([mod]) => callback?.(mod));
  }
  dispose(cb) {
    this.hmrClient.disposeMap.set(this.ownerPath, cb);
  }
  prune(cb) {
    this.hmrClient.pruneMap.set(this.ownerPath, cb);
  }
  // Kept for backward compatibility (#11036)
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  decline() {
  }
  invalidate(message) {
    this.hmrClient.notifyListeners("vite:invalidate", {
      path: this.ownerPath,
      message
    });
    this.send("vite:invalidate", { path: this.ownerPath, message });
    this.hmrClient.logger.debug(
      `[vite] invalidate ${this.ownerPath}${message ? `: ${message}` : ""}`
    );
  }
  on(event, cb) {
    const addToMap = (map) => {
      const existing = map.get(event) || [];
      existing.push(cb);
      map.set(event, existing);
    };
    addToMap(this.hmrClient.customListenersMap);
    addToMap(this.newListeners);
  }
  off(event, cb) {
    const removeFromMap = (map) => {
      const existing = map.get(event);
      if (existing === void 0) {
        return;
      }
      const pruned = existing.filter((l) => l !== cb);
      if (pruned.length === 0) {
        map.delete(event);
        return;
      }
      map.set(event, pruned);
    };
    removeFromMap(this.hmrClient.customListenersMap);
    removeFromMap(this.newListeners);
  }
  send(event, data) {
    this.hmrClient.messenger.send(
      JSON.stringify({ type: "custom", event, data })
    );
  }
  acceptDeps(deps, callback = () => {
  }) {
    const mod = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath,
      callbacks: []
    };
    mod.callbacks.push({
      deps,
      fn: callback
    });
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod);
  }
}
class HMRMessenger {
  constructor(connection) {
    this.connection = connection;
    this.queue = [];
  }
  send(message) {
    this.queue.push(message);
    this.flush();
  }
  flush() {
    if (this.connection.isReady()) {
      this.queue.forEach((msg) => this.connection.send(msg));
      this.queue = [];
    }
  }
}
class HMRClient {
  constructor(logger, connection, importUpdatedModule) {
    this.logger = logger;
    this.importUpdatedModule = importUpdatedModule;
    this.hotModulesMap = /* @__PURE__ */ new Map();
    this.disposeMap = /* @__PURE__ */ new Map();
    this.pruneMap = /* @__PURE__ */ new Map();
    this.dataMap = /* @__PURE__ */ new Map();
    this.customListenersMap = /* @__PURE__ */ new Map();
    this.ctxToListenersMap = /* @__PURE__ */ new Map();
    this.updateQueue = [];
    this.pendingUpdateQueue = false;
    this.messenger = new HMRMessenger(connection);
  }
  async notifyListeners(event, data) {
    const cbs = this.customListenersMap.get(event);
    if (cbs) {
      await Promise.allSettled(cbs.map((cb) => cb(data)));
    }
  }
  clear() {
    this.hotModulesMap.clear();
    this.disposeMap.clear();
    this.pruneMap.clear();
    this.dataMap.clear();
    this.customListenersMap.clear();
    this.ctxToListenersMap.clear();
  }
  // After an HMR update, some modules are no longer imported on the page
  // but they may have left behind side effects that need to be cleaned up
  // (.e.g style injections)
  async prunePaths(paths) {
    await Promise.all(
      paths.map((path) => {
        const disposer = this.disposeMap.get(path);
        if (disposer) return disposer(this.dataMap.get(path));
      })
    );
    paths.forEach((path) => {
      const fn = this.pruneMap.get(path);
      if (fn) {
        fn(this.dataMap.get(path));
      }
    });
  }
  warnFailedUpdate(err, path) {
    if (!err.message.includes("fetch")) {
      this.logger.error(err);
    }
    this.logger.error(
      `[hmr] Failed to reload ${path}. This could be due to syntax errors or importing non-existent modules. (see errors above)`
    );
  }
  /**
   * buffer multiple hot updates triggered by the same src change
   * so that they are invoked in the same order they were sent.
   * (otherwise the order may be inconsistent because of the http request round trip)
   */
  async queueUpdate(payload) {
    this.updateQueue.push(this.fetchUpdate(payload));
    if (!this.pendingUpdateQueue) {
      this.pendingUpdateQueue = true;
      await Promise.resolve();
      this.pendingUpdateQueue = false;
      const loading = [...this.updateQueue];
      this.updateQueue = [];
      (await Promise.all(loading)).forEach((fn) => fn && fn());
    }
  }
  async fetchUpdate(update) {
    const { path, acceptedPath } = update;
    const mod = this.hotModulesMap.get(path);
    if (!mod) {
      return;
    }
    let fetchedModule;
    const isSelfUpdate = path === acceptedPath;
    const qualifiedCallbacks = mod.callbacks.filter(
      ({ deps }) => deps.includes(acceptedPath)
    );
    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      const disposer = this.disposeMap.get(acceptedPath);
      if (disposer) await disposer(this.dataMap.get(acceptedPath));
      try {
        fetchedModule = await this.importUpdatedModule(update);
      } catch (e) {
        this.warnFailedUpdate(e, acceptedPath);
      }
    }
    return () => {
      for (const { deps, fn } of qualifiedCallbacks) {
        fn(
          deps.map((dep) => dep === acceptedPath ? fetchedModule : void 0)
        );
      }
      const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`;
      this.logger.debug(`[vite] hot updated: ${loggedPath}`);
    };
  }
}

const hmrConfigName = "vite.config.js";
const base$1 = "/pokedex/" || "/";
function h(e, attrs = {}, ...children) {
  const elem = document.createElement(e);
  for (const [k, v] of Object.entries(attrs)) {
    elem.setAttribute(k, v);
  }
  elem.append(...children);
  return elem;
}
const templateStyle = (
  /*css*/
  `
:host {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 99999;
  --monospace: 'SFMono-Regular', Consolas,
  'Liberation Mono', Menlo, Courier, monospace;
  --red: #ff5555;
  --yellow: #e2aa53;
  --purple: #cfa4ff;
  --cyan: #2dd9da;
  --dim: #c9c9c9;

  --window-background: #181818;
  --window-color: #d8d8d8;
}

.backdrop {
  position: fixed;
  z-index: 99999;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow-y: scroll;
  margin: 0;
  background: rgba(0, 0, 0, 0.66);
}

.window {
  font-family: var(--monospace);
  line-height: 1.5;
  max-width: 80vw;
  color: var(--window-color);
  box-sizing: border-box;
  margin: 30px auto;
  padding: 2.5vh 4vw;
  position: relative;
  background: var(--window-background);
  border-radius: 6px 6px 8px 8px;
  box-shadow: 0 19px 38px rgba(0,0,0,0.30), 0 15px 12px rgba(0,0,0,0.22);
  overflow: hidden;
  border-top: 8px solid var(--red);
  direction: ltr;
  text-align: left;
}

pre {
  font-family: var(--monospace);
  font-size: 16px;
  margin-top: 0;
  margin-bottom: 1em;
  overflow-x: scroll;
  scrollbar-width: none;
}

pre::-webkit-scrollbar {
  display: none;
}

pre.frame::-webkit-scrollbar {
  display: block;
  height: 5px;
}

pre.frame::-webkit-scrollbar-thumb {
  background: #999;
  border-radius: 5px;
}

pre.frame {
  scrollbar-width: thin;
}

.message {
  line-height: 1.3;
  font-weight: 600;
  white-space: pre-wrap;
}

.message-body {
  color: var(--red);
}

.plugin {
  color: var(--purple);
}

.file {
  color: var(--cyan);
  margin-bottom: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.frame {
  color: var(--yellow);
}

.stack {
  font-size: 13px;
  color: var(--dim);
}

.tip {
  font-size: 13px;
  color: #999;
  border-top: 1px dotted #999;
  padding-top: 13px;
  line-height: 1.8;
}

code {
  font-size: 13px;
  font-family: var(--monospace);
  color: var(--yellow);
}

.file-link {
  text-decoration: underline;
  cursor: pointer;
}

kbd {
  line-height: 1.5;
  font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.75rem;
  font-weight: 700;
  background-color: rgb(38, 40, 44);
  color: rgb(166, 167, 171);
  padding: 0.15rem 0.3rem;
  border-radius: 0.25rem;
  border-width: 0.0625rem 0.0625rem 0.1875rem;
  border-style: solid;
  border-color: rgb(54, 57, 64);
  border-image: initial;
}
`
);
const createTemplate = () => h(
  "div",
  { class: "backdrop", part: "backdrop" },
  h(
    "div",
    { class: "window", part: "window" },
    h(
      "pre",
      { class: "message", part: "message" },
      h("span", { class: "plugin", part: "plugin" }),
      h("span", { class: "message-body", part: "message-body" })
    ),
    h("pre", { class: "file", part: "file" }),
    h("pre", { class: "frame", part: "frame" }),
    h("pre", { class: "stack", part: "stack" }),
    h(
      "div",
      { class: "tip", part: "tip" },
      "Click outside, press ",
      h("kbd", {}, "Esc"),
      " key, or fix the code to dismiss.",
      h("br"),
      "You can also disable this overlay by setting ",
      h("code", { part: "config-option-name" }, "server.hmr.overlay"),
      " to ",
      h("code", { part: "config-option-value" }, "false"),
      " in ",
      h("code", { part: "config-file-name" }, hmrConfigName),
      "."
    )
  ),
  h("style", {}, templateStyle)
);
const fileRE = /(?:[a-zA-Z]:\\|\/).*?:\d+:\d+/g;
const codeframeRE = /^(?:>?\s*\d+\s+\|.*|\s+\|\s*\^.*)\r?\n/gm;
const { HTMLElement = class {
} } = globalThis;
class ErrorOverlay extends HTMLElement {
  constructor(err, links = true) {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(createTemplate());
    codeframeRE.lastIndex = 0;
    const hasFrame = err.frame && codeframeRE.test(err.frame);
    const message = hasFrame ? err.message.replace(codeframeRE, "") : err.message;
    if (err.plugin) {
      this.text(".plugin", `[plugin:${err.plugin}] `);
    }
    this.text(".message-body", message.trim());
    const [file] = (err.loc?.file || err.id || "unknown file").split(`?`);
    if (err.loc) {
      this.text(".file", `${file}:${err.loc.line}:${err.loc.column}`, links);
    } else if (err.id) {
      this.text(".file", file);
    }
    if (hasFrame) {
      this.text(".frame", err.frame.trim());
    }
    this.text(".stack", err.stack, links);
    this.root.querySelector(".window").addEventListener("click", (e) => {
      e.stopPropagation();
    });
    this.addEventListener("click", () => {
      this.close();
    });
    this.closeOnEsc = (e) => {
      if (e.key === "Escape" || e.code === "Escape") {
        this.close();
      }
    };
    document.addEventListener("keydown", this.closeOnEsc);
  }
  text(selector, text, linkFiles = false) {
    const el = this.root.querySelector(selector);
    if (!linkFiles) {
      el.textContent = text;
    } else {
      let curIndex = 0;
      let match;
      fileRE.lastIndex = 0;
      while (match = fileRE.exec(text)) {
        const { 0: file, index } = match;
        if (index != null) {
          const frag = text.slice(curIndex, index);
          el.appendChild(document.createTextNode(frag));
          const link = document.createElement("a");
          link.textContent = file;
          link.className = "file-link";
          link.onclick = () => {
            fetch(
              new URL(
                `${base$1}__open-in-editor?file=${encodeURIComponent(file)}`,
                import.meta.url
              )
            );
          };
          el.appendChild(link);
          curIndex += frag.length + file.length;
        }
      }
    }
  }
  close() {
    this.parentNode?.removeChild(this);
    document.removeEventListener("keydown", this.closeOnEsc);
  }
}
const overlayId = "vite-error-overlay";
const { customElements } = globalThis;
if (customElements && !customElements.get(overlayId)) {
  customElements.define(overlayId, ErrorOverlay);
}

console.debug("[vite] connecting...");
const importMetaUrl = new URL(import.meta.url);
const serverHost = "localhost:undefined/pokedex/";
const socketProtocol = null || (importMetaUrl.protocol === "https:" ? "wss" : "ws");
const hmrPort = null;
const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/pokedex/"}`;
const directSocketHost = "localhost:undefined/pokedex/";
const base = "/pokedex/" || "/";
let socket;
try {
  let fallback;
  if (!hmrPort) {
    fallback = () => {
      socket = setupWebSocket(socketProtocol, directSocketHost, () => {
        const currentScriptHostURL = new URL(import.meta.url);
        const currentScriptHost = currentScriptHostURL.host + currentScriptHostURL.pathname.replace(/@vite\/client$/, "");
        console.error(
          `[vite] failed to connect to websocket.
your current setup:
  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)
  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)
Check out your Vite / network configuration and https://vite.dev/config/server-options.html#server-hmr .`
        );
      });
      socket.addEventListener(
        "open",
        () => {
          console.info(
            "[vite] Direct websocket connection fallback. Check out https://vite.dev/config/server-options.html#server-hmr to remove the previous connection error."
          );
        },
        { once: true }
      );
    };
  }
  socket = setupWebSocket(socketProtocol, socketHost, fallback);
} catch (error) {
  console.error(`[vite] failed to connect to websocket (${error}). `);
}
function setupWebSocket(protocol, hostAndPath, onCloseWithoutOpen) {
  const socket2 = new WebSocket(`${protocol}://${hostAndPath}`, "vite-hmr");
  let isOpened = false;
  socket2.addEventListener(
    "open",
    () => {
      isOpened = true;
      notifyListeners("vite:ws:connect", { webSocket: socket2 });
    },
    { once: true }
  );
  socket2.addEventListener("message", async ({ data }) => {
    handleMessage(JSON.parse(data));
  });
  socket2.addEventListener("close", async ({ wasClean }) => {
    if (wasClean) return;
    if (!isOpened && onCloseWithoutOpen) {
      onCloseWithoutOpen();
      return;
    }
    notifyListeners("vite:ws:disconnect", { webSocket: socket2 });
    if (hasDocument) {
      console.log(`[vite] server connection lost. Polling for restart...`);
      await waitForSuccessfulPing(protocol, hostAndPath);
      location.reload();
    }
  });
  return socket2;
}
function cleanUrl(pathname) {
  const url = new URL(pathname, "http://vite.dev");
  url.searchParams.delete("direct");
  return url.pathname + url.search;
}
let isFirstUpdate = true;
const outdatedLinkTags = /* @__PURE__ */ new WeakSet();
const debounceReload = (time) => {
  let timer;
  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      location.reload();
    }, time);
  };
};
const pageReload = debounceReload(50);
const hmrClient = new HMRClient(
  console,
  {
    isReady: () => socket && socket.readyState === 1,
    send: (message) => socket.send(message)
  },
  async function importUpdatedModule({
    acceptedPath,
    timestamp,
    explicitImportRequired,
    isWithinCircularImport
  }) {
    const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`);
    const importPromise = import(
      /* @vite-ignore */
      base + acceptedPathWithoutQuery.slice(1) + `?${explicitImportRequired ? "import&" : ""}t=${timestamp}${query ? `&${query}` : ""}`
    );
    if (isWithinCircularImport) {
      importPromise.catch(() => {
        console.info(
          `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reloading page to reset the execution order. To debug and break the circular import, you can run \`vite --debug hmr\` to log the circular dependency path if a file change triggered it.`
        );
        pageReload();
      });
    }
    return await importPromise;
  }
);
async function handleMessage(payload) {
  switch (payload.type) {
    case "connected":
      console.debug(`[vite] connected.`);
      hmrClient.messenger.flush();
      setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send('{"type":"ping"}');
        }
      }, 30000);
      break;
    case "update":
      notifyListeners("vite:beforeUpdate", payload);
      if (hasDocument) {
        if (isFirstUpdate && hasErrorOverlay()) {
          location.reload();
          return;
        } else {
          if (enableOverlay) {
            clearErrorOverlay();
          }
          isFirstUpdate = false;
        }
      }
      await Promise.all(
        payload.updates.map(async (update) => {
          if (update.type === "js-update") {
            return hmrClient.queueUpdate(update);
          }
          const { path, timestamp } = update;
          const searchUrl = cleanUrl(path);
          const el = Array.from(
            document.querySelectorAll("link")
          ).find(
            (e) => !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl)
          );
          if (!el) {
            return;
          }
          const newPath = `${base}${searchUrl.slice(1)}${searchUrl.includes("?") ? "&" : "?"}t=${timestamp}`;
          return new Promise((resolve) => {
            const newLinkTag = el.cloneNode();
            newLinkTag.href = new URL(newPath, el.href).href;
            const removeOldEl = () => {
              el.remove();
              console.debug(`[vite] css hot updated: ${searchUrl}`);
              resolve();
            };
            newLinkTag.addEventListener("load", removeOldEl);
            newLinkTag.addEventListener("error", removeOldEl);
            outdatedLinkTags.add(el);
            el.after(newLinkTag);
          });
        })
      );
      notifyListeners("vite:afterUpdate", payload);
      break;
    case "custom": {
      notifyListeners(payload.event, payload.data);
      break;
    }
    case "full-reload":
      notifyListeners("vite:beforeFullReload", payload);
      if (hasDocument) {
        if (payload.path && payload.path.endsWith(".html")) {
          const pagePath = decodeURI(location.pathname);
          const payloadPath = base + payload.path.slice(1);
          if (pagePath === payloadPath || payload.path === "/index.html" || pagePath.endsWith("/") && pagePath + "index.html" === payloadPath) {
            pageReload();
          }
          return;
        } else {
          pageReload();
        }
      }
      break;
    case "prune":
      notifyListeners("vite:beforePrune", payload);
      await hmrClient.prunePaths(payload.paths);
      break;
    case "error": {
      notifyListeners("vite:error", payload);
      if (hasDocument) {
        const err = payload.err;
        if (enableOverlay) {
          createErrorOverlay(err);
        } else {
          console.error(
            `[vite] Internal Server Error
${err.message}
${err.stack}`
          );
        }
      }
      break;
    }
    default: {
      const check = payload;
      return check;
    }
  }
}
function notifyListeners(event, data) {
  hmrClient.notifyListeners(event, data);
}
const enableOverlay = true;
const hasDocument = "document" in globalThis;
function createErrorOverlay(err) {
  clearErrorOverlay();
  document.body.appendChild(new ErrorOverlay(err));
}
function clearErrorOverlay() {
  document.querySelectorAll(overlayId).forEach((n) => n.close());
}
function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length;
}
async function waitForSuccessfulPing(socketProtocol2, hostAndPath, ms = 1e3) {
  const pingHostProtocol = socketProtocol2 === "wss" ? "https" : "http";
  const ping = async () => {
    try {
      await fetch(`${pingHostProtocol}://${hostAndPath}`, {
        mode: "no-cors",
        headers: {
          // Custom headers won't be included in a request with no-cors so (ab)use one of the
          // safelisted headers to identify the ping request
          Accept: "text/x-vite-ping"
        }
      });
      return true;
    } catch {
    }
    return false;
  };
  if (await ping()) {
    return;
  }
  await wait(ms);
  while (true) {
    if (document.visibilityState === "visible") {
      if (await ping()) {
        break;
      }
      await wait(ms);
    } else {
      await waitForWindowShow();
    }
  }
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function waitForWindowShow() {
  return new Promise((resolve) => {
    const onChange = async () => {
      if (document.visibilityState === "visible") {
        resolve();
        document.removeEventListener("visibilitychange", onChange);
      }
    };
    document.addEventListener("visibilitychange", onChange);
  });
}
const sheetsMap = /* @__PURE__ */ new Map();
if ("document" in globalThis) {
  document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => {
    sheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
}
const cspNonce = "document" in globalThis ? document.querySelector("meta[property=csp-nonce]")?.nonce : void 0;
let lastInsertedStyle;
function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    if (cspNonce) {
      style.setAttribute("nonce", cspNonce);
    }
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => {
        lastInsertedStyle = void 0;
      }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
function createHotContext(ownerPath) {
  return new HMRContext(hmrClient, ownerPath);
}
function injectQuery(url, queryToInject) {
  if (url[0] !== "." && url[0] !== "/") {
    return url;
  }
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vite.dev");
  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ""}${hash || ""}`;
}

export { ErrorOverlay, createHotContext, injectQuery, removeStyle, updateStyle };

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNsaWVudCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgXCIvcG9rZWRleC9ub2RlX21vZHVsZXMvdml0ZS9kaXN0L2NsaWVudC9lbnYubWpzXCI7XG5cbmNsYXNzIEhNUkNvbnRleHQge1xuICBjb25zdHJ1Y3RvcihobXJDbGllbnQsIG93bmVyUGF0aCkge1xuICAgIHRoaXMuaG1yQ2xpZW50ID0gaG1yQ2xpZW50O1xuICAgIHRoaXMub3duZXJQYXRoID0gb3duZXJQYXRoO1xuICAgIGlmICghaG1yQ2xpZW50LmRhdGFNYXAuaGFzKG93bmVyUGF0aCkpIHtcbiAgICAgIGhtckNsaWVudC5kYXRhTWFwLnNldChvd25lclBhdGgsIHt9KTtcbiAgICB9XG4gICAgY29uc3QgbW9kID0gaG1yQ2xpZW50LmhvdE1vZHVsZXNNYXAuZ2V0KG93bmVyUGF0aCk7XG4gICAgaWYgKG1vZCkge1xuICAgICAgbW9kLmNhbGxiYWNrcyA9IFtdO1xuICAgIH1cbiAgICBjb25zdCBzdGFsZUxpc3RlbmVycyA9IGhtckNsaWVudC5jdHhUb0xpc3RlbmVyc01hcC5nZXQob3duZXJQYXRoKTtcbiAgICBpZiAoc3RhbGVMaXN0ZW5lcnMpIHtcbiAgICAgIGZvciAoY29uc3QgW2V2ZW50LCBzdGFsZUZuc10gb2Ygc3RhbGVMaXN0ZW5lcnMpIHtcbiAgICAgICAgY29uc3QgbGlzdGVuZXJzID0gaG1yQ2xpZW50LmN1c3RvbUxpc3RlbmVyc01hcC5nZXQoZXZlbnQpO1xuICAgICAgICBpZiAobGlzdGVuZXJzKSB7XG4gICAgICAgICAgaG1yQ2xpZW50LmN1c3RvbUxpc3RlbmVyc01hcC5zZXQoXG4gICAgICAgICAgICBldmVudCxcbiAgICAgICAgICAgIGxpc3RlbmVycy5maWx0ZXIoKGwpID0+ICFzdGFsZUZucy5pbmNsdWRlcyhsKSlcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMubmV3TGlzdGVuZXJzID0gLyogQF9fUFVSRV9fICovIG5ldyBNYXAoKTtcbiAgICBobXJDbGllbnQuY3R4VG9MaXN0ZW5lcnNNYXAuc2V0KG93bmVyUGF0aCwgdGhpcy5uZXdMaXN0ZW5lcnMpO1xuICB9XG4gIGdldCBkYXRhKCkge1xuICAgIHJldHVybiB0aGlzLmhtckNsaWVudC5kYXRhTWFwLmdldCh0aGlzLm93bmVyUGF0aCk7XG4gIH1cbiAgYWNjZXB0KGRlcHMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKHR5cGVvZiBkZXBzID09PSBcImZ1bmN0aW9uXCIgfHwgIWRlcHMpIHtcbiAgICAgIHRoaXMuYWNjZXB0RGVwcyhbdGhpcy5vd25lclBhdGhdLCAoW21vZF0pID0+IGRlcHM/Lihtb2QpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBkZXBzID09PSBcInN0cmluZ1wiKSB7XG4gICAgICB0aGlzLmFjY2VwdERlcHMoW2RlcHNdLCAoW21vZF0pID0+IGNhbGxiYWNrPy4obW9kKSk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KGRlcHMpKSB7XG4gICAgICB0aGlzLmFjY2VwdERlcHMoZGVwcywgY2FsbGJhY2spO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgaG90LmFjY2VwdCgpIHVzYWdlLmApO1xuICAgIH1cbiAgfVxuICAvLyBleHBvcnQgbmFtZXMgKGZpcnN0IGFyZykgYXJlIGlycmVsZXZhbnQgb24gdGhlIGNsaWVudCBzaWRlLCB0aGV5J3JlXG4gIC8vIGV4dHJhY3RlZCBpbiB0aGUgc2VydmVyIGZvciBwcm9wYWdhdGlvblxuICBhY2NlcHRFeHBvcnRzKF8sIGNhbGxiYWNrKSB7XG4gICAgdGhpcy5hY2NlcHREZXBzKFt0aGlzLm93bmVyUGF0aF0sIChbbW9kXSkgPT4gY2FsbGJhY2s/Lihtb2QpKTtcbiAgfVxuICBkaXNwb3NlKGNiKSB7XG4gICAgdGhpcy5obXJDbGllbnQuZGlzcG9zZU1hcC5zZXQodGhpcy5vd25lclBhdGgsIGNiKTtcbiAgfVxuICBwcnVuZShjYikge1xuICAgIHRoaXMuaG1yQ2xpZW50LnBydW5lTWFwLnNldCh0aGlzLm93bmVyUGF0aCwgY2IpO1xuICB9XG4gIC8vIEtlcHQgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgKCMxMTAzNilcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1lbXB0eS1mdW5jdGlvblxuICBkZWNsaW5lKCkge1xuICB9XG4gIGludmFsaWRhdGUobWVzc2FnZSkge1xuICAgIHRoaXMuaG1yQ2xpZW50Lm5vdGlmeUxpc3RlbmVycyhcInZpdGU6aW52YWxpZGF0ZVwiLCB7XG4gICAgICBwYXRoOiB0aGlzLm93bmVyUGF0aCxcbiAgICAgIG1lc3NhZ2VcbiAgICB9KTtcbiAgICB0aGlzLnNlbmQoXCJ2aXRlOmludmFsaWRhdGVcIiwgeyBwYXRoOiB0aGlzLm93bmVyUGF0aCwgbWVzc2FnZSB9KTtcbiAgICB0aGlzLmhtckNsaWVudC5sb2dnZXIuZGVidWcoXG4gICAgICBgW3ZpdGVdIGludmFsaWRhdGUgJHt0aGlzLm93bmVyUGF0aH0ke21lc3NhZ2UgPyBgOiAke21lc3NhZ2V9YCA6IFwiXCJ9YFxuICAgICk7XG4gIH1cbiAgb24oZXZlbnQsIGNiKSB7XG4gICAgY29uc3QgYWRkVG9NYXAgPSAobWFwKSA9PiB7XG4gICAgICBjb25zdCBleGlzdGluZyA9IG1hcC5nZXQoZXZlbnQpIHx8IFtdO1xuICAgICAgZXhpc3RpbmcucHVzaChjYik7XG4gICAgICBtYXAuc2V0KGV2ZW50LCBleGlzdGluZyk7XG4gICAgfTtcbiAgICBhZGRUb01hcCh0aGlzLmhtckNsaWVudC5jdXN0b21MaXN0ZW5lcnNNYXApO1xuICAgIGFkZFRvTWFwKHRoaXMubmV3TGlzdGVuZXJzKTtcbiAgfVxuICBvZmYoZXZlbnQsIGNiKSB7XG4gICAgY29uc3QgcmVtb3ZlRnJvbU1hcCA9IChtYXApID0+IHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWFwLmdldChldmVudCk7XG4gICAgICBpZiAoZXhpc3RpbmcgPT09IHZvaWQgMCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCBwcnVuZWQgPSBleGlzdGluZy5maWx0ZXIoKGwpID0+IGwgIT09IGNiKTtcbiAgICAgIGlmIChwcnVuZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIG1hcC5kZWxldGUoZXZlbnQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBtYXAuc2V0KGV2ZW50LCBwcnVuZWQpO1xuICAgIH07XG4gICAgcmVtb3ZlRnJvbU1hcCh0aGlzLmhtckNsaWVudC5jdXN0b21MaXN0ZW5lcnNNYXApO1xuICAgIHJlbW92ZUZyb21NYXAodGhpcy5uZXdMaXN0ZW5lcnMpO1xuICB9XG4gIHNlbmQoZXZlbnQsIGRhdGEpIHtcbiAgICB0aGlzLmhtckNsaWVudC5tZXNzZW5nZXIuc2VuZChcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJjdXN0b21cIiwgZXZlbnQsIGRhdGEgfSlcbiAgICApO1xuICB9XG4gIGFjY2VwdERlcHMoZGVwcywgY2FsbGJhY2sgPSAoKSA9PiB7XG4gIH0pIHtcbiAgICBjb25zdCBtb2QgPSB0aGlzLmhtckNsaWVudC5ob3RNb2R1bGVzTWFwLmdldCh0aGlzLm93bmVyUGF0aCkgfHwge1xuICAgICAgaWQ6IHRoaXMub3duZXJQYXRoLFxuICAgICAgY2FsbGJhY2tzOiBbXVxuICAgIH07XG4gICAgbW9kLmNhbGxiYWNrcy5wdXNoKHtcbiAgICAgIGRlcHMsXG4gICAgICBmbjogY2FsbGJhY2tcbiAgICB9KTtcbiAgICB0aGlzLmhtckNsaWVudC5ob3RNb2R1bGVzTWFwLnNldCh0aGlzLm93bmVyUGF0aCwgbW9kKTtcbiAgfVxufVxuY2xhc3MgSE1STWVzc2VuZ2VyIHtcbiAgY29uc3RydWN0b3IoY29ubmVjdGlvbikge1xuICAgIHRoaXMuY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gICAgdGhpcy5xdWV1ZSA9IFtdO1xuICB9XG4gIHNlbmQobWVzc2FnZSkge1xuICAgIHRoaXMucXVldWUucHVzaChtZXNzYWdlKTtcbiAgICB0aGlzLmZsdXNoKCk7XG4gIH1cbiAgZmx1c2goKSB7XG4gICAgaWYgKHRoaXMuY29ubmVjdGlvbi5pc1JlYWR5KCkpIHtcbiAgICAgIHRoaXMucXVldWUuZm9yRWFjaCgobXNnKSA9PiB0aGlzLmNvbm5lY3Rpb24uc2VuZChtc2cpKTtcbiAgICAgIHRoaXMucXVldWUgPSBbXTtcbiAgICB9XG4gIH1cbn1cbmNsYXNzIEhNUkNsaWVudCB7XG4gIGNvbnN0cnVjdG9yKGxvZ2dlciwgY29ubmVjdGlvbiwgaW1wb3J0VXBkYXRlZE1vZHVsZSkge1xuICAgIHRoaXMubG9nZ2VyID0gbG9nZ2VyO1xuICAgIHRoaXMuaW1wb3J0VXBkYXRlZE1vZHVsZSA9IGltcG9ydFVwZGF0ZWRNb2R1bGU7XG4gICAgdGhpcy5ob3RNb2R1bGVzTWFwID0gLyogQF9fUFVSRV9fICovIG5ldyBNYXAoKTtcbiAgICB0aGlzLmRpc3Bvc2VNYXAgPSAvKiBAX19QVVJFX18gKi8gbmV3IE1hcCgpO1xuICAgIHRoaXMucHJ1bmVNYXAgPSAvKiBAX19QVVJFX18gKi8gbmV3IE1hcCgpO1xuICAgIHRoaXMuZGF0YU1hcCA9IC8qIEBfX1BVUkVfXyAqLyBuZXcgTWFwKCk7XG4gICAgdGhpcy5jdXN0b21MaXN0ZW5lcnNNYXAgPSAvKiBAX19QVVJFX18gKi8gbmV3IE1hcCgpO1xuICAgIHRoaXMuY3R4VG9MaXN0ZW5lcnNNYXAgPSAvKiBAX19QVVJFX18gKi8gbmV3IE1hcCgpO1xuICAgIHRoaXMudXBkYXRlUXVldWUgPSBbXTtcbiAgICB0aGlzLnBlbmRpbmdVcGRhdGVRdWV1ZSA9IGZhbHNlO1xuICAgIHRoaXMubWVzc2VuZ2VyID0gbmV3IEhNUk1lc3Nlbmdlcihjb25uZWN0aW9uKTtcbiAgfVxuICBhc3luYyBub3RpZnlMaXN0ZW5lcnMoZXZlbnQsIGRhdGEpIHtcbiAgICBjb25zdCBjYnMgPSB0aGlzLmN1c3RvbUxpc3RlbmVyc01hcC5nZXQoZXZlbnQpO1xuICAgIGlmIChjYnMpIHtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChjYnMubWFwKChjYikgPT4gY2IoZGF0YSkpKTtcbiAgICB9XG4gIH1cbiAgY2xlYXIoKSB7XG4gICAgdGhpcy5ob3RNb2R1bGVzTWFwLmNsZWFyKCk7XG4gICAgdGhpcy5kaXNwb3NlTWFwLmNsZWFyKCk7XG4gICAgdGhpcy5wcnVuZU1hcC5jbGVhcigpO1xuICAgIHRoaXMuZGF0YU1hcC5jbGVhcigpO1xuICAgIHRoaXMuY3VzdG9tTGlzdGVuZXJzTWFwLmNsZWFyKCk7XG4gICAgdGhpcy5jdHhUb0xpc3RlbmVyc01hcC5jbGVhcigpO1xuICB9XG4gIC8vIEFmdGVyIGFuIEhNUiB1cGRhdGUsIHNvbWUgbW9kdWxlcyBhcmUgbm8gbG9uZ2VyIGltcG9ydGVkIG9uIHRoZSBwYWdlXG4gIC8vIGJ1dCB0aGV5IG1heSBoYXZlIGxlZnQgYmVoaW5kIHNpZGUgZWZmZWN0cyB0aGF0IG5lZWQgdG8gYmUgY2xlYW5lZCB1cFxuICAvLyAoLmUuZyBzdHlsZSBpbmplY3Rpb25zKVxuICBhc3luYyBwcnVuZVBhdGhzKHBhdGhzKSB7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICBwYXRocy5tYXAoKHBhdGgpID0+IHtcbiAgICAgICAgY29uc3QgZGlzcG9zZXIgPSB0aGlzLmRpc3Bvc2VNYXAuZ2V0KHBhdGgpO1xuICAgICAgICBpZiAoZGlzcG9zZXIpIHJldHVybiBkaXNwb3Nlcih0aGlzLmRhdGFNYXAuZ2V0KHBhdGgpKTtcbiAgICAgIH0pXG4gICAgKTtcbiAgICBwYXRocy5mb3JFYWNoKChwYXRoKSA9PiB7XG4gICAgICBjb25zdCBmbiA9IHRoaXMucHJ1bmVNYXAuZ2V0KHBhdGgpO1xuICAgICAgaWYgKGZuKSB7XG4gICAgICAgIGZuKHRoaXMuZGF0YU1hcC5nZXQocGF0aCkpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHdhcm5GYWlsZWRVcGRhdGUoZXJyLCBwYXRoKSB7XG4gICAgaWYgKCFlcnIubWVzc2FnZS5pbmNsdWRlcyhcImZldGNoXCIpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihlcnIpO1xuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5lcnJvcihcbiAgICAgIGBbaG1yXSBGYWlsZWQgdG8gcmVsb2FkICR7cGF0aH0uIFRoaXMgY291bGQgYmUgZHVlIHRvIHN5bnRheCBlcnJvcnMgb3IgaW1wb3J0aW5nIG5vbi1leGlzdGVudCBtb2R1bGVzLiAoc2VlIGVycm9ycyBhYm92ZSlgXG4gICAgKTtcbiAgfVxuICAvKipcbiAgICogYnVmZmVyIG11bHRpcGxlIGhvdCB1cGRhdGVzIHRyaWdnZXJlZCBieSB0aGUgc2FtZSBzcmMgY2hhbmdlXG4gICAqIHNvIHRoYXQgdGhleSBhcmUgaW52b2tlZCBpbiB0aGUgc2FtZSBvcmRlciB0aGV5IHdlcmUgc2VudC5cbiAgICogKG90aGVyd2lzZSB0aGUgb3JkZXIgbWF5IGJlIGluY29uc2lzdGVudCBiZWNhdXNlIG9mIHRoZSBodHRwIHJlcXVlc3Qgcm91bmQgdHJpcClcbiAgICovXG4gIGFzeW5jIHF1ZXVlVXBkYXRlKHBheWxvYWQpIHtcbiAgICB0aGlzLnVwZGF0ZVF1ZXVlLnB1c2godGhpcy5mZXRjaFVwZGF0ZShwYXlsb2FkKSk7XG4gICAgaWYgKCF0aGlzLnBlbmRpbmdVcGRhdGVRdWV1ZSkge1xuICAgICAgdGhpcy5wZW5kaW5nVXBkYXRlUXVldWUgPSB0cnVlO1xuICAgICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB0aGlzLnBlbmRpbmdVcGRhdGVRdWV1ZSA9IGZhbHNlO1xuICAgICAgY29uc3QgbG9hZGluZyA9IFsuLi50aGlzLnVwZGF0ZVF1ZXVlXTtcbiAgICAgIHRoaXMudXBkYXRlUXVldWUgPSBbXTtcbiAgICAgIChhd2FpdCBQcm9taXNlLmFsbChsb2FkaW5nKSkuZm9yRWFjaCgoZm4pID0+IGZuICYmIGZuKCkpO1xuICAgIH1cbiAgfVxuICBhc3luYyBmZXRjaFVwZGF0ZSh1cGRhdGUpIHtcbiAgICBjb25zdCB7IHBhdGgsIGFjY2VwdGVkUGF0aCB9ID0gdXBkYXRlO1xuICAgIGNvbnN0IG1vZCA9IHRoaXMuaG90TW9kdWxlc01hcC5nZXQocGF0aCk7XG4gICAgaWYgKCFtb2QpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IGZldGNoZWRNb2R1bGU7XG4gICAgY29uc3QgaXNTZWxmVXBkYXRlID0gcGF0aCA9PT0gYWNjZXB0ZWRQYXRoO1xuICAgIGNvbnN0IHF1YWxpZmllZENhbGxiYWNrcyA9IG1vZC5jYWxsYmFja3MuZmlsdGVyKFxuICAgICAgKHsgZGVwcyB9KSA9PiBkZXBzLmluY2x1ZGVzKGFjY2VwdGVkUGF0aClcbiAgICApO1xuICAgIGlmIChpc1NlbGZVcGRhdGUgfHwgcXVhbGlmaWVkQ2FsbGJhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGRpc3Bvc2VyID0gdGhpcy5kaXNwb3NlTWFwLmdldChhY2NlcHRlZFBhdGgpO1xuICAgICAgaWYgKGRpc3Bvc2VyKSBhd2FpdCBkaXNwb3Nlcih0aGlzLmRhdGFNYXAuZ2V0KGFjY2VwdGVkUGF0aCkpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZmV0Y2hlZE1vZHVsZSA9IGF3YWl0IHRoaXMuaW1wb3J0VXBkYXRlZE1vZHVsZSh1cGRhdGUpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB0aGlzLndhcm5GYWlsZWRVcGRhdGUoZSwgYWNjZXB0ZWRQYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgeyBkZXBzLCBmbiB9IG9mIHF1YWxpZmllZENhbGxiYWNrcykge1xuICAgICAgICBmbihcbiAgICAgICAgICBkZXBzLm1hcCgoZGVwKSA9PiBkZXAgPT09IGFjY2VwdGVkUGF0aCA/IGZldGNoZWRNb2R1bGUgOiB2b2lkIDApXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBsb2dnZWRQYXRoID0gaXNTZWxmVXBkYXRlID8gcGF0aCA6IGAke2FjY2VwdGVkUGF0aH0gdmlhICR7cGF0aH1gO1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoYFt2aXRlXSBob3QgdXBkYXRlZDogJHtsb2dnZWRQYXRofWApO1xuICAgIH07XG4gIH1cbn1cblxuY29uc3QgaG1yQ29uZmlnTmFtZSA9IFwidml0ZS5jb25maWcuanNcIjtcbmNvbnN0IGJhc2UkMSA9IFwiL3Bva2VkZXgvXCIgfHwgXCIvXCI7XG5mdW5jdGlvbiBoKGUsIGF0dHJzID0ge30sIC4uLmNoaWxkcmVuKSB7XG4gIGNvbnN0IGVsZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGUpO1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhhdHRycykpIHtcbiAgICBlbGVtLnNldEF0dHJpYnV0ZShrLCB2KTtcbiAgfVxuICBlbGVtLmFwcGVuZCguLi5jaGlsZHJlbik7XG4gIHJldHVybiBlbGVtO1xufVxuY29uc3QgdGVtcGxhdGVTdHlsZSA9IChcbiAgLypjc3MqL1xuICBgXG46aG9zdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgdG9wOiAwO1xuICBsZWZ0OiAwO1xuICB3aWR0aDogMTAwJTtcbiAgaGVpZ2h0OiAxMDAlO1xuICB6LWluZGV4OiA5OTk5OTtcbiAgLS1tb25vc3BhY2U6ICdTRk1vbm8tUmVndWxhcicsIENvbnNvbGFzLFxuICAnTGliZXJhdGlvbiBNb25vJywgTWVubG8sIENvdXJpZXIsIG1vbm9zcGFjZTtcbiAgLS1yZWQ6ICNmZjU1NTU7XG4gIC0teWVsbG93OiAjZTJhYTUzO1xuICAtLXB1cnBsZTogI2NmYTRmZjtcbiAgLS1jeWFuOiAjMmRkOWRhO1xuICAtLWRpbTogI2M5YzljOTtcblxuICAtLXdpbmRvdy1iYWNrZ3JvdW5kOiAjMTgxODE4O1xuICAtLXdpbmRvdy1jb2xvcjogI2Q4ZDhkODtcbn1cblxuLmJhY2tkcm9wIHtcbiAgcG9zaXRpb246IGZpeGVkO1xuICB6LWluZGV4OiA5OTk5OTtcbiAgdG9wOiAwO1xuICBsZWZ0OiAwO1xuICB3aWR0aDogMTAwJTtcbiAgaGVpZ2h0OiAxMDAlO1xuICBvdmVyZmxvdy15OiBzY3JvbGw7XG4gIG1hcmdpbjogMDtcbiAgYmFja2dyb3VuZDogcmdiYSgwLCAwLCAwLCAwLjY2KTtcbn1cblxuLndpbmRvdyB7XG4gIGZvbnQtZmFtaWx5OiB2YXIoLS1tb25vc3BhY2UpO1xuICBsaW5lLWhlaWdodDogMS41O1xuICBtYXgtd2lkdGg6IDgwdnc7XG4gIGNvbG9yOiB2YXIoLS13aW5kb3ctY29sb3IpO1xuICBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICBtYXJnaW46IDMwcHggYXV0bztcbiAgcGFkZGluZzogMi41dmggNHZ3O1xuICBwb3NpdGlvbjogcmVsYXRpdmU7XG4gIGJhY2tncm91bmQ6IHZhcigtLXdpbmRvdy1iYWNrZ3JvdW5kKTtcbiAgYm9yZGVyLXJhZGl1czogNnB4IDZweCA4cHggOHB4O1xuICBib3gtc2hhZG93OiAwIDE5cHggMzhweCByZ2JhKDAsMCwwLDAuMzApLCAwIDE1cHggMTJweCByZ2JhKDAsMCwwLDAuMjIpO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICBib3JkZXItdG9wOiA4cHggc29saWQgdmFyKC0tcmVkKTtcbiAgZGlyZWN0aW9uOiBsdHI7XG4gIHRleHQtYWxpZ246IGxlZnQ7XG59XG5cbnByZSB7XG4gIGZvbnQtZmFtaWx5OiB2YXIoLS1tb25vc3BhY2UpO1xuICBmb250LXNpemU6IDE2cHg7XG4gIG1hcmdpbi10b3A6IDA7XG4gIG1hcmdpbi1ib3R0b206IDFlbTtcbiAgb3ZlcmZsb3cteDogc2Nyb2xsO1xuICBzY3JvbGxiYXItd2lkdGg6IG5vbmU7XG59XG5cbnByZTo6LXdlYmtpdC1zY3JvbGxiYXIge1xuICBkaXNwbGF5OiBub25lO1xufVxuXG5wcmUuZnJhbWU6Oi13ZWJraXQtc2Nyb2xsYmFyIHtcbiAgZGlzcGxheTogYmxvY2s7XG4gIGhlaWdodDogNXB4O1xufVxuXG5wcmUuZnJhbWU6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHtcbiAgYmFja2dyb3VuZDogIzk5OTtcbiAgYm9yZGVyLXJhZGl1czogNXB4O1xufVxuXG5wcmUuZnJhbWUge1xuICBzY3JvbGxiYXItd2lkdGg6IHRoaW47XG59XG5cbi5tZXNzYWdlIHtcbiAgbGluZS1oZWlnaHQ6IDEuMztcbiAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgd2hpdGUtc3BhY2U6IHByZS13cmFwO1xufVxuXG4ubWVzc2FnZS1ib2R5IHtcbiAgY29sb3I6IHZhcigtLXJlZCk7XG59XG5cbi5wbHVnaW4ge1xuICBjb2xvcjogdmFyKC0tcHVycGxlKTtcbn1cblxuLmZpbGUge1xuICBjb2xvcjogdmFyKC0tY3lhbik7XG4gIG1hcmdpbi1ib3R0b206IDA7XG4gIHdoaXRlLXNwYWNlOiBwcmUtd3JhcDtcbiAgd29yZC1icmVhazogYnJlYWstYWxsO1xufVxuXG4uZnJhbWUge1xuICBjb2xvcjogdmFyKC0teWVsbG93KTtcbn1cblxuLnN0YWNrIHtcbiAgZm9udC1zaXplOiAxM3B4O1xuICBjb2xvcjogdmFyKC0tZGltKTtcbn1cblxuLnRpcCB7XG4gIGZvbnQtc2l6ZTogMTNweDtcbiAgY29sb3I6ICM5OTk7XG4gIGJvcmRlci10b3A6IDFweCBkb3R0ZWQgIzk5OTtcbiAgcGFkZGluZy10b3A6IDEzcHg7XG4gIGxpbmUtaGVpZ2h0OiAxLjg7XG59XG5cbmNvZGUge1xuICBmb250LXNpemU6IDEzcHg7XG4gIGZvbnQtZmFtaWx5OiB2YXIoLS1tb25vc3BhY2UpO1xuICBjb2xvcjogdmFyKC0teWVsbG93KTtcbn1cblxuLmZpbGUtbGluayB7XG4gIHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lO1xuICBjdXJzb3I6IHBvaW50ZXI7XG59XG5cbmtiZCB7XG4gIGxpbmUtaGVpZ2h0OiAxLjU7XG4gIGZvbnQtZmFtaWx5OiB1aS1tb25vc3BhY2UsIE1lbmxvLCBNb25hY28sIENvbnNvbGFzLCBcIkxpYmVyYXRpb24gTW9ub1wiLCBcIkNvdXJpZXIgTmV3XCIsIG1vbm9zcGFjZTtcbiAgZm9udC1zaXplOiAwLjc1cmVtO1xuICBmb250LXdlaWdodDogNzAwO1xuICBiYWNrZ3JvdW5kLWNvbG9yOiByZ2IoMzgsIDQwLCA0NCk7XG4gIGNvbG9yOiByZ2IoMTY2LCAxNjcsIDE3MSk7XG4gIHBhZGRpbmc6IDAuMTVyZW0gMC4zcmVtO1xuICBib3JkZXItcmFkaXVzOiAwLjI1cmVtO1xuICBib3JkZXItd2lkdGg6IDAuMDYyNXJlbSAwLjA2MjVyZW0gMC4xODc1cmVtO1xuICBib3JkZXItc3R5bGU6IHNvbGlkO1xuICBib3JkZXItY29sb3I6IHJnYig1NCwgNTcsIDY0KTtcbiAgYm9yZGVyLWltYWdlOiBpbml0aWFsO1xufVxuYFxuKTtcbmNvbnN0IGNyZWF0ZVRlbXBsYXRlID0gKCkgPT4gaChcbiAgXCJkaXZcIixcbiAgeyBjbGFzczogXCJiYWNrZHJvcFwiLCBwYXJ0OiBcImJhY2tkcm9wXCIgfSxcbiAgaChcbiAgICBcImRpdlwiLFxuICAgIHsgY2xhc3M6IFwid2luZG93XCIsIHBhcnQ6IFwid2luZG93XCIgfSxcbiAgICBoKFxuICAgICAgXCJwcmVcIixcbiAgICAgIHsgY2xhc3M6IFwibWVzc2FnZVwiLCBwYXJ0OiBcIm1lc3NhZ2VcIiB9LFxuICAgICAgaChcInNwYW5cIiwgeyBjbGFzczogXCJwbHVnaW5cIiwgcGFydDogXCJwbHVnaW5cIiB9KSxcbiAgICAgIGgoXCJzcGFuXCIsIHsgY2xhc3M6IFwibWVzc2FnZS1ib2R5XCIsIHBhcnQ6IFwibWVzc2FnZS1ib2R5XCIgfSlcbiAgICApLFxuICAgIGgoXCJwcmVcIiwgeyBjbGFzczogXCJmaWxlXCIsIHBhcnQ6IFwiZmlsZVwiIH0pLFxuICAgIGgoXCJwcmVcIiwgeyBjbGFzczogXCJmcmFtZVwiLCBwYXJ0OiBcImZyYW1lXCIgfSksXG4gICAgaChcInByZVwiLCB7IGNsYXNzOiBcInN0YWNrXCIsIHBhcnQ6IFwic3RhY2tcIiB9KSxcbiAgICBoKFxuICAgICAgXCJkaXZcIixcbiAgICAgIHsgY2xhc3M6IFwidGlwXCIsIHBhcnQ6IFwidGlwXCIgfSxcbiAgICAgIFwiQ2xpY2sgb3V0c2lkZSwgcHJlc3MgXCIsXG4gICAgICBoKFwia2JkXCIsIHt9LCBcIkVzY1wiKSxcbiAgICAgIFwiIGtleSwgb3IgZml4IHRoZSBjb2RlIHRvIGRpc21pc3MuXCIsXG4gICAgICBoKFwiYnJcIiksXG4gICAgICBcIllvdSBjYW4gYWxzbyBkaXNhYmxlIHRoaXMgb3ZlcmxheSBieSBzZXR0aW5nIFwiLFxuICAgICAgaChcImNvZGVcIiwgeyBwYXJ0OiBcImNvbmZpZy1vcHRpb24tbmFtZVwiIH0sIFwic2VydmVyLmhtci5vdmVybGF5XCIpLFxuICAgICAgXCIgdG8gXCIsXG4gICAgICBoKFwiY29kZVwiLCB7IHBhcnQ6IFwiY29uZmlnLW9wdGlvbi12YWx1ZVwiIH0sIFwiZmFsc2VcIiksXG4gICAgICBcIiBpbiBcIixcbiAgICAgIGgoXCJjb2RlXCIsIHsgcGFydDogXCJjb25maWctZmlsZS1uYW1lXCIgfSwgaG1yQ29uZmlnTmFtZSksXG4gICAgICBcIi5cIlxuICAgIClcbiAgKSxcbiAgaChcInN0eWxlXCIsIHt9LCB0ZW1wbGF0ZVN0eWxlKVxuKTtcbmNvbnN0IGZpbGVSRSA9IC8oPzpbYS16QS1aXTpcXFxcfFxcLykuKj86XFxkKzpcXGQrL2c7XG5jb25zdCBjb2RlZnJhbWVSRSA9IC9eKD86Pj9cXHMqXFxkK1xccytcXHwuKnxcXHMrXFx8XFxzKlxcXi4qKVxccj9cXG4vZ207XG5jb25zdCB7IEhUTUxFbGVtZW50ID0gY2xhc3Mge1xufSB9ID0gZ2xvYmFsVGhpcztcbmNsYXNzIEVycm9yT3ZlcmxheSBleHRlbmRzIEhUTUxFbGVtZW50IHtcbiAgY29uc3RydWN0b3IoZXJyLCBsaW5rcyA9IHRydWUpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucm9vdCA9IHRoaXMuYXR0YWNoU2hhZG93KHsgbW9kZTogXCJvcGVuXCIgfSk7XG4gICAgdGhpcy5yb290LmFwcGVuZENoaWxkKGNyZWF0ZVRlbXBsYXRlKCkpO1xuICAgIGNvZGVmcmFtZVJFLmxhc3RJbmRleCA9IDA7XG4gICAgY29uc3QgaGFzRnJhbWUgPSBlcnIuZnJhbWUgJiYgY29kZWZyYW1lUkUudGVzdChlcnIuZnJhbWUpO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBoYXNGcmFtZSA/IGVyci5tZXNzYWdlLnJlcGxhY2UoY29kZWZyYW1lUkUsIFwiXCIpIDogZXJyLm1lc3NhZ2U7XG4gICAgaWYgKGVyci5wbHVnaW4pIHtcbiAgICAgIHRoaXMudGV4dChcIi5wbHVnaW5cIiwgYFtwbHVnaW46JHtlcnIucGx1Z2lufV0gYCk7XG4gICAgfVxuICAgIHRoaXMudGV4dChcIi5tZXNzYWdlLWJvZHlcIiwgbWVzc2FnZS50cmltKCkpO1xuICAgIGNvbnN0IFtmaWxlXSA9IChlcnIubG9jPy5maWxlIHx8IGVyci5pZCB8fCBcInVua25vd24gZmlsZVwiKS5zcGxpdChgP2ApO1xuICAgIGlmIChlcnIubG9jKSB7XG4gICAgICB0aGlzLnRleHQoXCIuZmlsZVwiLCBgJHtmaWxlfToke2Vyci5sb2MubGluZX06JHtlcnIubG9jLmNvbHVtbn1gLCBsaW5rcyk7XG4gICAgfSBlbHNlIGlmIChlcnIuaWQpIHtcbiAgICAgIHRoaXMudGV4dChcIi5maWxlXCIsIGZpbGUpO1xuICAgIH1cbiAgICBpZiAoaGFzRnJhbWUpIHtcbiAgICAgIHRoaXMudGV4dChcIi5mcmFtZVwiLCBlcnIuZnJhbWUudHJpbSgpKTtcbiAgICB9XG4gICAgdGhpcy50ZXh0KFwiLnN0YWNrXCIsIGVyci5zdGFjaywgbGlua3MpO1xuICAgIHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLndpbmRvd1wiKS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgfSk7XG4gICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgdGhpcy5jbG9zZSgpO1xuICAgIH0pO1xuICAgIHRoaXMuY2xvc2VPbkVzYyA9IChlKSA9PiB7XG4gICAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIgfHwgZS5jb2RlID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICAgIH1cbiAgICB9O1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIHRoaXMuY2xvc2VPbkVzYyk7XG4gIH1cbiAgdGV4dChzZWxlY3RvciwgdGV4dCwgbGlua0ZpbGVzID0gZmFsc2UpIHtcbiAgICBjb25zdCBlbCA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICBpZiAoIWxpbmtGaWxlcykge1xuICAgICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgY3VySW5kZXggPSAwO1xuICAgICAgbGV0IG1hdGNoO1xuICAgICAgZmlsZVJFLmxhc3RJbmRleCA9IDA7XG4gICAgICB3aGlsZSAobWF0Y2ggPSBmaWxlUkUuZXhlYyh0ZXh0KSkge1xuICAgICAgICBjb25zdCB7IDA6IGZpbGUsIGluZGV4IH0gPSBtYXRjaDtcbiAgICAgICAgaWYgKGluZGV4ICE9IG51bGwpIHtcbiAgICAgICAgICBjb25zdCBmcmFnID0gdGV4dC5zbGljZShjdXJJbmRleCwgaW5kZXgpO1xuICAgICAgICAgIGVsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKGZyYWcpKTtcbiAgICAgICAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgICAgICAgbGluay50ZXh0Q29udGVudCA9IGZpbGU7XG4gICAgICAgICAgbGluay5jbGFzc05hbWUgPSBcImZpbGUtbGlua1wiO1xuICAgICAgICAgIGxpbmsub25jbGljayA9ICgpID0+IHtcbiAgICAgICAgICAgIGZldGNoKFxuICAgICAgICAgICAgICBuZXcgVVJMKFxuICAgICAgICAgICAgICAgIGAke2Jhc2UkMX1fX29wZW4taW4tZWRpdG9yP2ZpbGU9JHtlbmNvZGVVUklDb21wb25lbnQoZmlsZSl9YCxcbiAgICAgICAgICAgICAgICBpbXBvcnQubWV0YS51cmxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9O1xuICAgICAgICAgIGVsLmFwcGVuZENoaWxkKGxpbmspO1xuICAgICAgICAgIGN1ckluZGV4ICs9IGZyYWcubGVuZ3RoICsgZmlsZS5sZW5ndGg7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY2xvc2UoKSB7XG4gICAgdGhpcy5wYXJlbnROb2RlPy5yZW1vdmVDaGlsZCh0aGlzKTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCB0aGlzLmNsb3NlT25Fc2MpO1xuICB9XG59XG5jb25zdCBvdmVybGF5SWQgPSBcInZpdGUtZXJyb3Itb3ZlcmxheVwiO1xuY29uc3QgeyBjdXN0b21FbGVtZW50cyB9ID0gZ2xvYmFsVGhpcztcbmlmIChjdXN0b21FbGVtZW50cyAmJiAhY3VzdG9tRWxlbWVudHMuZ2V0KG92ZXJsYXlJZCkpIHtcbiAgY3VzdG9tRWxlbWVudHMuZGVmaW5lKG92ZXJsYXlJZCwgRXJyb3JPdmVybGF5KTtcbn1cblxuY29uc29sZS5kZWJ1ZyhcIlt2aXRlXSBjb25uZWN0aW5nLi4uXCIpO1xuY29uc3QgaW1wb3J0TWV0YVVybCA9IG5ldyBVUkwoaW1wb3J0Lm1ldGEudXJsKTtcbmNvbnN0IHNlcnZlckhvc3QgPSBcImxvY2FsaG9zdDp1bmRlZmluZWQvcG9rZWRleC9cIjtcbmNvbnN0IHNvY2tldFByb3RvY29sID0gbnVsbCB8fCAoaW1wb3J0TWV0YVVybC5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCIpO1xuY29uc3QgaG1yUG9ydCA9IG51bGw7XG5jb25zdCBzb2NrZXRIb3N0ID0gYCR7bnVsbCB8fCBpbXBvcnRNZXRhVXJsLmhvc3RuYW1lfToke2htclBvcnQgfHwgaW1wb3J0TWV0YVVybC5wb3J0fSR7XCIvcG9rZWRleC9cIn1gO1xuY29uc3QgZGlyZWN0U29ja2V0SG9zdCA9IFwibG9jYWxob3N0OnVuZGVmaW5lZC9wb2tlZGV4L1wiO1xuY29uc3QgYmFzZSA9IFwiL3Bva2VkZXgvXCIgfHwgXCIvXCI7XG5sZXQgc29ja2V0O1xudHJ5IHtcbiAgbGV0IGZhbGxiYWNrO1xuICBpZiAoIWhtclBvcnQpIHtcbiAgICBmYWxsYmFjayA9ICgpID0+IHtcbiAgICAgIHNvY2tldCA9IHNldHVwV2ViU29ja2V0KHNvY2tldFByb3RvY29sLCBkaXJlY3RTb2NrZXRIb3N0LCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGN1cnJlbnRTY3JpcHRIb3N0VVJMID0gbmV3IFVSTChpbXBvcnQubWV0YS51cmwpO1xuICAgICAgICBjb25zdCBjdXJyZW50U2NyaXB0SG9zdCA9IGN1cnJlbnRTY3JpcHRIb3N0VVJMLmhvc3QgKyBjdXJyZW50U2NyaXB0SG9zdFVSTC5wYXRobmFtZS5yZXBsYWNlKC9Adml0ZVxcL2NsaWVudCQvLCBcIlwiKTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgW3ZpdGVdIGZhaWxlZCB0byBjb25uZWN0IHRvIHdlYnNvY2tldC5cbnlvdXIgY3VycmVudCBzZXR1cDpcbiAgKGJyb3dzZXIpICR7Y3VycmVudFNjcmlwdEhvc3R9IDwtLVtIVFRQXS0tPiAke3NlcnZlckhvc3R9IChzZXJ2ZXIpXG4gIChicm93c2VyKSAke3NvY2tldEhvc3R9IDwtLVtXZWJTb2NrZXQgKGZhaWxpbmcpXS0tPiAke2RpcmVjdFNvY2tldEhvc3R9IChzZXJ2ZXIpXG5DaGVjayBvdXQgeW91ciBWaXRlIC8gbmV0d29yayBjb25maWd1cmF0aW9uIGFuZCBodHRwczovL3ZpdGUuZGV2L2NvbmZpZy9zZXJ2ZXItb3B0aW9ucy5odG1sI3NlcnZlci1obXIgLmBcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgY29uc29sZS5pbmZvKFxuICAgICAgICAgICAgXCJbdml0ZV0gRGlyZWN0IHdlYnNvY2tldCBjb25uZWN0aW9uIGZhbGxiYWNrLiBDaGVjayBvdXQgaHR0cHM6Ly92aXRlLmRldi9jb25maWcvc2VydmVyLW9wdGlvbnMuaHRtbCNzZXJ2ZXItaG1yIHRvIHJlbW92ZSB0aGUgcHJldmlvdXMgY29ubmVjdGlvbiBlcnJvci5cIlxuICAgICAgICAgICk7XG4gICAgICAgIH0sXG4gICAgICAgIHsgb25jZTogdHJ1ZSB9XG4gICAgICApO1xuICAgIH07XG4gIH1cbiAgc29ja2V0ID0gc2V0dXBXZWJTb2NrZXQoc29ja2V0UHJvdG9jb2wsIHNvY2tldEhvc3QsIGZhbGxiYWNrKTtcbn0gY2F0Y2ggKGVycm9yKSB7XG4gIGNvbnNvbGUuZXJyb3IoYFt2aXRlXSBmYWlsZWQgdG8gY29ubmVjdCB0byB3ZWJzb2NrZXQgKCR7ZXJyb3J9KS4gYCk7XG59XG5mdW5jdGlvbiBzZXR1cFdlYlNvY2tldChwcm90b2NvbCwgaG9zdEFuZFBhdGgsIG9uQ2xvc2VXaXRob3V0T3Blbikge1xuICBjb25zdCBzb2NrZXQyID0gbmV3IFdlYlNvY2tldChgJHtwcm90b2NvbH06Ly8ke2hvc3RBbmRQYXRofWAsIFwidml0ZS1obXJcIik7XG4gIGxldCBpc09wZW5lZCA9IGZhbHNlO1xuICBzb2NrZXQyLmFkZEV2ZW50TGlzdGVuZXIoXG4gICAgXCJvcGVuXCIsXG4gICAgKCkgPT4ge1xuICAgICAgaXNPcGVuZWQgPSB0cnVlO1xuICAgICAgbm90aWZ5TGlzdGVuZXJzKFwidml0ZTp3czpjb25uZWN0XCIsIHsgd2ViU29ja2V0OiBzb2NrZXQyIH0pO1xuICAgIH0sXG4gICAgeyBvbmNlOiB0cnVlIH1cbiAgKTtcbiAgc29ja2V0Mi5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBhc3luYyAoeyBkYXRhIH0pID0+IHtcbiAgICBoYW5kbGVNZXNzYWdlKEpTT04ucGFyc2UoZGF0YSkpO1xuICB9KTtcbiAgc29ja2V0Mi5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgYXN5bmMgKHsgd2FzQ2xlYW4gfSkgPT4ge1xuICAgIGlmICh3YXNDbGVhbikgcmV0dXJuO1xuICAgIGlmICghaXNPcGVuZWQgJiYgb25DbG9zZVdpdGhvdXRPcGVuKSB7XG4gICAgICBvbkNsb3NlV2l0aG91dE9wZW4oKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbm90aWZ5TGlzdGVuZXJzKFwidml0ZTp3czpkaXNjb25uZWN0XCIsIHsgd2ViU29ja2V0OiBzb2NrZXQyIH0pO1xuICAgIGlmIChoYXNEb2N1bWVudCkge1xuICAgICAgY29uc29sZS5sb2coYFt2aXRlXSBzZXJ2ZXIgY29ubmVjdGlvbiBsb3N0LiBQb2xsaW5nIGZvciByZXN0YXJ0Li4uYCk7XG4gICAgICBhd2FpdCB3YWl0Rm9yU3VjY2Vzc2Z1bFBpbmcocHJvdG9jb2wsIGhvc3RBbmRQYXRoKTtcbiAgICAgIGxvY2F0aW9uLnJlbG9hZCgpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBzb2NrZXQyO1xufVxuZnVuY3Rpb24gY2xlYW5VcmwocGF0aG5hbWUpIHtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChwYXRobmFtZSwgXCJodHRwOi8vdml0ZS5kZXZcIik7XG4gIHVybC5zZWFyY2hQYXJhbXMuZGVsZXRlKFwiZGlyZWN0XCIpO1xuICByZXR1cm4gdXJsLnBhdGhuYW1lICsgdXJsLnNlYXJjaDtcbn1cbmxldCBpc0ZpcnN0VXBkYXRlID0gdHJ1ZTtcbmNvbnN0IG91dGRhdGVkTGlua1RhZ3MgPSAvKiBAX19QVVJFX18gKi8gbmV3IFdlYWtTZXQoKTtcbmNvbnN0IGRlYm91bmNlUmVsb2FkID0gKHRpbWUpID0+IHtcbiAgbGV0IHRpbWVyO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGlmICh0aW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHRpbWVyID0gbnVsbDtcbiAgICB9XG4gICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIGxvY2F0aW9uLnJlbG9hZCgpO1xuICAgIH0sIHRpbWUpO1xuICB9O1xufTtcbmNvbnN0IHBhZ2VSZWxvYWQgPSBkZWJvdW5jZVJlbG9hZCg1MCk7XG5jb25zdCBobXJDbGllbnQgPSBuZXcgSE1SQ2xpZW50KFxuICBjb25zb2xlLFxuICB7XG4gICAgaXNSZWFkeTogKCkgPT4gc29ja2V0ICYmIHNvY2tldC5yZWFkeVN0YXRlID09PSAxLFxuICAgIHNlbmQ6IChtZXNzYWdlKSA9PiBzb2NrZXQuc2VuZChtZXNzYWdlKVxuICB9LFxuICBhc3luYyBmdW5jdGlvbiBpbXBvcnRVcGRhdGVkTW9kdWxlKHtcbiAgICBhY2NlcHRlZFBhdGgsXG4gICAgdGltZXN0YW1wLFxuICAgIGV4cGxpY2l0SW1wb3J0UmVxdWlyZWQsXG4gICAgaXNXaXRoaW5DaXJjdWxhckltcG9ydFxuICB9KSB7XG4gICAgY29uc3QgW2FjY2VwdGVkUGF0aFdpdGhvdXRRdWVyeSwgcXVlcnldID0gYWNjZXB0ZWRQYXRoLnNwbGl0KGA/YCk7XG4gICAgY29uc3QgaW1wb3J0UHJvbWlzZSA9IGltcG9ydChcbiAgICAgIC8qIEB2aXRlLWlnbm9yZSAqL1xuICAgICAgYmFzZSArIGFjY2VwdGVkUGF0aFdpdGhvdXRRdWVyeS5zbGljZSgxKSArIGA/JHtleHBsaWNpdEltcG9ydFJlcXVpcmVkID8gXCJpbXBvcnQmXCIgOiBcIlwifXQ9JHt0aW1lc3RhbXB9JHtxdWVyeSA/IGAmJHtxdWVyeX1gIDogXCJcIn1gXG4gICAgKTtcbiAgICBpZiAoaXNXaXRoaW5DaXJjdWxhckltcG9ydCkge1xuICAgICAgaW1wb3J0UHJvbWlzZS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcbiAgICAgICAgICBgW2htcl0gJHthY2NlcHRlZFBhdGh9IGZhaWxlZCB0byBhcHBseSBITVIgYXMgaXQncyB3aXRoaW4gYSBjaXJjdWxhciBpbXBvcnQuIFJlbG9hZGluZyBwYWdlIHRvIHJlc2V0IHRoZSBleGVjdXRpb24gb3JkZXIuIFRvIGRlYnVnIGFuZCBicmVhayB0aGUgY2lyY3VsYXIgaW1wb3J0LCB5b3UgY2FuIHJ1biBcXGB2aXRlIC0tZGVidWcgaG1yXFxgIHRvIGxvZyB0aGUgY2lyY3VsYXIgZGVwZW5kZW5jeSBwYXRoIGlmIGEgZmlsZSBjaGFuZ2UgdHJpZ2dlcmVkIGl0LmBcbiAgICAgICAgKTtcbiAgICAgICAgcGFnZVJlbG9hZCgpO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBpbXBvcnRQcm9taXNlO1xuICB9XG4pO1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlTWVzc2FnZShwYXlsb2FkKSB7XG4gIHN3aXRjaCAocGF5bG9hZC50eXBlKSB7XG4gICAgY2FzZSBcImNvbm5lY3RlZFwiOlxuICAgICAgY29uc29sZS5kZWJ1ZyhgW3ZpdGVdIGNvbm5lY3RlZC5gKTtcbiAgICAgIGhtckNsaWVudC5tZXNzZW5nZXIuZmx1c2goKTtcbiAgICAgIHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKHNvY2tldC5yZWFkeVN0YXRlID09PSBzb2NrZXQuT1BFTikge1xuICAgICAgICAgIHNvY2tldC5zZW5kKCd7XCJ0eXBlXCI6XCJwaW5nXCJ9Jyk7XG4gICAgICAgIH1cbiAgICAgIH0sIDMwMDAwKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJ1cGRhdGVcIjpcbiAgICAgIG5vdGlmeUxpc3RlbmVycyhcInZpdGU6YmVmb3JlVXBkYXRlXCIsIHBheWxvYWQpO1xuICAgICAgaWYgKGhhc0RvY3VtZW50KSB7XG4gICAgICAgIGlmIChpc0ZpcnN0VXBkYXRlICYmIGhhc0Vycm9yT3ZlcmxheSgpKSB7XG4gICAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChlbmFibGVPdmVybGF5KSB7XG4gICAgICAgICAgICBjbGVhckVycm9yT3ZlcmxheSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpc0ZpcnN0VXBkYXRlID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICBwYXlsb2FkLnVwZGF0ZXMubWFwKGFzeW5jICh1cGRhdGUpID0+IHtcbiAgICAgICAgICBpZiAodXBkYXRlLnR5cGUgPT09IFwianMtdXBkYXRlXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBobXJDbGllbnQucXVldWVVcGRhdGUodXBkYXRlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgeyBwYXRoLCB0aW1lc3RhbXAgfSA9IHVwZGF0ZTtcbiAgICAgICAgICBjb25zdCBzZWFyY2hVcmwgPSBjbGVhblVybChwYXRoKTtcbiAgICAgICAgICBjb25zdCBlbCA9IEFycmF5LmZyb20oXG4gICAgICAgICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwibGlua1wiKVxuICAgICAgICAgICkuZmluZChcbiAgICAgICAgICAgIChlKSA9PiAhb3V0ZGF0ZWRMaW5rVGFncy5oYXMoZSkgJiYgY2xlYW5VcmwoZS5ocmVmKS5pbmNsdWRlcyhzZWFyY2hVcmwpXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAoIWVsKSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBgJHtiYXNlfSR7c2VhcmNoVXJsLnNsaWNlKDEpfSR7c2VhcmNoVXJsLmluY2x1ZGVzKFwiP1wiKSA/IFwiJlwiIDogXCI/XCJ9dD0ke3RpbWVzdGFtcH1gO1xuICAgICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbmV3TGlua1RhZyA9IGVsLmNsb25lTm9kZSgpO1xuICAgICAgICAgICAgbmV3TGlua1RhZy5ocmVmID0gbmV3IFVSTChuZXdQYXRoLCBlbC5ocmVmKS5ocmVmO1xuICAgICAgICAgICAgY29uc3QgcmVtb3ZlT2xkRWwgPSAoKSA9PiB7XG4gICAgICAgICAgICAgIGVsLnJlbW92ZSgpO1xuICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKGBbdml0ZV0gY3NzIGhvdCB1cGRhdGVkOiAke3NlYXJjaFVybH1gKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIG5ld0xpbmtUYWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgcmVtb3ZlT2xkRWwpO1xuICAgICAgICAgICAgbmV3TGlua1RhZy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgcmVtb3ZlT2xkRWwpO1xuICAgICAgICAgICAgb3V0ZGF0ZWRMaW5rVGFncy5hZGQoZWwpO1xuICAgICAgICAgICAgZWwuYWZ0ZXIobmV3TGlua1RhZyk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICApO1xuICAgICAgbm90aWZ5TGlzdGVuZXJzKFwidml0ZTphZnRlclVwZGF0ZVwiLCBwYXlsb2FkKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJjdXN0b21cIjoge1xuICAgICAgbm90aWZ5TGlzdGVuZXJzKHBheWxvYWQuZXZlbnQsIHBheWxvYWQuZGF0YSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImZ1bGwtcmVsb2FkXCI6XG4gICAgICBub3RpZnlMaXN0ZW5lcnMoXCJ2aXRlOmJlZm9yZUZ1bGxSZWxvYWRcIiwgcGF5bG9hZCk7XG4gICAgICBpZiAoaGFzRG9jdW1lbnQpIHtcbiAgICAgICAgaWYgKHBheWxvYWQucGF0aCAmJiBwYXlsb2FkLnBhdGguZW5kc1dpdGgoXCIuaHRtbFwiKSkge1xuICAgICAgICAgIGNvbnN0IHBhZ2VQYXRoID0gZGVjb2RlVVJJKGxvY2F0aW9uLnBhdGhuYW1lKTtcbiAgICAgICAgICBjb25zdCBwYXlsb2FkUGF0aCA9IGJhc2UgKyBwYXlsb2FkLnBhdGguc2xpY2UoMSk7XG4gICAgICAgICAgaWYgKHBhZ2VQYXRoID09PSBwYXlsb2FkUGF0aCB8fCBwYXlsb2FkLnBhdGggPT09IFwiL2luZGV4Lmh0bWxcIiB8fCBwYWdlUGF0aC5lbmRzV2l0aChcIi9cIikgJiYgcGFnZVBhdGggKyBcImluZGV4Lmh0bWxcIiA9PT0gcGF5bG9hZFBhdGgpIHtcbiAgICAgICAgICAgIHBhZ2VSZWxvYWQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHBhZ2VSZWxvYWQoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInBydW5lXCI6XG4gICAgICBub3RpZnlMaXN0ZW5lcnMoXCJ2aXRlOmJlZm9yZVBydW5lXCIsIHBheWxvYWQpO1xuICAgICAgYXdhaXQgaG1yQ2xpZW50LnBydW5lUGF0aHMocGF5bG9hZC5wYXRocyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXJyb3JcIjoge1xuICAgICAgbm90aWZ5TGlzdGVuZXJzKFwidml0ZTplcnJvclwiLCBwYXlsb2FkKTtcbiAgICAgIGlmIChoYXNEb2N1bWVudCkge1xuICAgICAgICBjb25zdCBlcnIgPSBwYXlsb2FkLmVycjtcbiAgICAgICAgaWYgKGVuYWJsZU92ZXJsYXkpIHtcbiAgICAgICAgICBjcmVhdGVFcnJvck92ZXJsYXkoZXJyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgYFt2aXRlXSBJbnRlcm5hbCBTZXJ2ZXIgRXJyb3JcbiR7ZXJyLm1lc3NhZ2V9XG4ke2Vyci5zdGFja31gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGRlZmF1bHQ6IHtcbiAgICAgIGNvbnN0IGNoZWNrID0gcGF5bG9hZDtcbiAgICAgIHJldHVybiBjaGVjaztcbiAgICB9XG4gIH1cbn1cbmZ1bmN0aW9uIG5vdGlmeUxpc3RlbmVycyhldmVudCwgZGF0YSkge1xuICBobXJDbGllbnQubm90aWZ5TGlzdGVuZXJzKGV2ZW50LCBkYXRhKTtcbn1cbmNvbnN0IGVuYWJsZU92ZXJsYXkgPSB0cnVlO1xuY29uc3QgaGFzRG9jdW1lbnQgPSBcImRvY3VtZW50XCIgaW4gZ2xvYmFsVGhpcztcbmZ1bmN0aW9uIGNyZWF0ZUVycm9yT3ZlcmxheShlcnIpIHtcbiAgY2xlYXJFcnJvck92ZXJsYXkoKTtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChuZXcgRXJyb3JPdmVybGF5KGVycikpO1xufVxuZnVuY3Rpb24gY2xlYXJFcnJvck92ZXJsYXkoKSB7XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwob3ZlcmxheUlkKS5mb3JFYWNoKChuKSA9PiBuLmNsb3NlKCkpO1xufVxuZnVuY3Rpb24gaGFzRXJyb3JPdmVybGF5KCkge1xuICByZXR1cm4gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChvdmVybGF5SWQpLmxlbmd0aDtcbn1cbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTdWNjZXNzZnVsUGluZyhzb2NrZXRQcm90b2NvbDIsIGhvc3RBbmRQYXRoLCBtcyA9IDFlMykge1xuICBjb25zdCBwaW5nSG9zdFByb3RvY29sID0gc29ja2V0UHJvdG9jb2wyID09PSBcIndzc1wiID8gXCJodHRwc1wiIDogXCJodHRwXCI7XG4gIGNvbnN0IHBpbmcgPSBhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGZldGNoKGAke3BpbmdIb3N0UHJvdG9jb2x9Oi8vJHtob3N0QW5kUGF0aH1gLCB7XG4gICAgICAgIG1vZGU6IFwibm8tY29yc1wiLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgLy8gQ3VzdG9tIGhlYWRlcnMgd29uJ3QgYmUgaW5jbHVkZWQgaW4gYSByZXF1ZXN0IHdpdGggbm8tY29ycyBzbyAoYWIpdXNlIG9uZSBvZiB0aGVcbiAgICAgICAgICAvLyBzYWZlbGlzdGVkIGhlYWRlcnMgdG8gaWRlbnRpZnkgdGhlIHBpbmcgcmVxdWVzdFxuICAgICAgICAgIEFjY2VwdDogXCJ0ZXh0L3gtdml0ZS1waW5nXCJcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9O1xuICBpZiAoYXdhaXQgcGluZygpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHdhaXQobXMpO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09IFwidmlzaWJsZVwiKSB7XG4gICAgICBpZiAoYXdhaXQgcGluZygpKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgYXdhaXQgd2FpdChtcyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGF3YWl0IHdhaXRGb3JXaW5kb3dTaG93KCk7XG4gICAgfVxuICB9XG59XG5mdW5jdGlvbiB3YWl0KG1zKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxuZnVuY3Rpb24gd2FpdEZvcldpbmRvd1Nob3coKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IG9uQ2hhbmdlID0gYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKGRvY3VtZW50LnZpc2liaWxpdHlTdGF0ZSA9PT0gXCJ2aXNpYmxlXCIpIHtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwidmlzaWJpbGl0eWNoYW5nZVwiLCBvbkNoYW5nZSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwidmlzaWJpbGl0eWNoYW5nZVwiLCBvbkNoYW5nZSk7XG4gIH0pO1xufVxuY29uc3Qgc2hlZXRzTWFwID0gLyogQF9fUFVSRV9fICovIG5ldyBNYXAoKTtcbmlmIChcImRvY3VtZW50XCIgaW4gZ2xvYmFsVGhpcykge1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwic3R5bGVbZGF0YS12aXRlLWRldi1pZF1cIikuZm9yRWFjaCgoZWwpID0+IHtcbiAgICBzaGVldHNNYXAuc2V0KGVsLmdldEF0dHJpYnV0ZShcImRhdGEtdml0ZS1kZXYtaWRcIiksIGVsKTtcbiAgfSk7XG59XG5jb25zdCBjc3BOb25jZSA9IFwiZG9jdW1lbnRcIiBpbiBnbG9iYWxUaGlzID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbcHJvcGVydHk9Y3NwLW5vbmNlXVwiKT8ubm9uY2UgOiB2b2lkIDA7XG5sZXQgbGFzdEluc2VydGVkU3R5bGU7XG5mdW5jdGlvbiB1cGRhdGVTdHlsZShpZCwgY29udGVudCkge1xuICBsZXQgc3R5bGUgPSBzaGVldHNNYXAuZ2V0KGlkKTtcbiAgaWYgKCFzdHlsZSkge1xuICAgIHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xuICAgIHN0eWxlLnNldEF0dHJpYnV0ZShcInR5cGVcIiwgXCJ0ZXh0L2Nzc1wiKTtcbiAgICBzdHlsZS5zZXRBdHRyaWJ1dGUoXCJkYXRhLXZpdGUtZGV2LWlkXCIsIGlkKTtcbiAgICBzdHlsZS50ZXh0Q29udGVudCA9IGNvbnRlbnQ7XG4gICAgaWYgKGNzcE5vbmNlKSB7XG4gICAgICBzdHlsZS5zZXRBdHRyaWJ1dGUoXCJub25jZVwiLCBjc3BOb25jZSk7XG4gICAgfVxuICAgIGlmICghbGFzdEluc2VydGVkU3R5bGUpIHtcbiAgICAgIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGxhc3RJbnNlcnRlZFN0eWxlID0gdm9pZCAwO1xuICAgICAgfSwgMCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxhc3RJbnNlcnRlZFN0eWxlLmluc2VydEFkamFjZW50RWxlbWVudChcImFmdGVyZW5kXCIsIHN0eWxlKTtcbiAgICB9XG4gICAgbGFzdEluc2VydGVkU3R5bGUgPSBzdHlsZTtcbiAgfSBlbHNlIHtcbiAgICBzdHlsZS50ZXh0Q29udGVudCA9IGNvbnRlbnQ7XG4gIH1cbiAgc2hlZXRzTWFwLnNldChpZCwgc3R5bGUpO1xufVxuZnVuY3Rpb24gcmVtb3ZlU3R5bGUoaWQpIHtcbiAgY29uc3Qgc3R5bGUgPSBzaGVldHNNYXAuZ2V0KGlkKTtcbiAgaWYgKHN0eWxlKSB7XG4gICAgZG9jdW1lbnQuaGVhZC5yZW1vdmVDaGlsZChzdHlsZSk7XG4gICAgc2hlZXRzTWFwLmRlbGV0ZShpZCk7XG4gIH1cbn1cbmZ1bmN0aW9uIGNyZWF0ZUhvdENvbnRleHQob3duZXJQYXRoKSB7XG4gIHJldHVybiBuZXcgSE1SQ29udGV4dChobXJDbGllbnQsIG93bmVyUGF0aCk7XG59XG5mdW5jdGlvbiBpbmplY3RRdWVyeSh1cmwsIHF1ZXJ5VG9JbmplY3QpIHtcbiAgaWYgKHVybFswXSAhPT0gXCIuXCIgJiYgdXJsWzBdICE9PSBcIi9cIikge1xuICAgIHJldHVybiB1cmw7XG4gIH1cbiAgY29uc3QgcGF0aG5hbWUgPSB1cmwucmVwbGFjZSgvWz8jXS4qJC8sIFwiXCIpO1xuICBjb25zdCB7IHNlYXJjaCwgaGFzaCB9ID0gbmV3IFVSTCh1cmwsIFwiaHR0cDovL3ZpdGUuZGV2XCIpO1xuICByZXR1cm4gYCR7cGF0aG5hbWV9PyR7cXVlcnlUb0luamVjdH0ke3NlYXJjaCA/IGAmYCArIHNlYXJjaC5zbGljZSgxKSA6IFwiXCJ9JHtoYXNoIHx8IFwiXCJ9YDtcbn1cblxuZXhwb3J0IHsgRXJyb3JPdmVybGF5LCBjcmVhdGVIb3RDb250ZXh0LCBpbmplY3RRdWVyeSwgcmVtb3ZlU3R5bGUsIHVwZGF0ZVN0eWxlIH07XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsTUFBTSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN4RDtBQUNBLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUNsQixDQUFDLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDL0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDL0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDdkQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQ3RFLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUN6QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQztBQUN2RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGtCQUFrQixDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNsRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxrQkFBa0IsQ0FBQyxHQUFHLENBQUM7QUFDM0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2xELENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDbEUsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNkLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDOUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMxRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNaLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNyRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUU7QUFDeEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsV0FBVztBQUM1QyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDOUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2xFLENBQUMsQ0FBQyxDQUFDO0FBQ0gsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3RELENBQUMsQ0FBQyxDQUFDO0FBQ0gsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3BELENBQUMsQ0FBQyxDQUFDO0FBQ0gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQzdDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsUUFBUTtBQUNsRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2IsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLGVBQWUsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztBQUMzQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPO0FBQ2IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3BFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0UsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNqQixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzVDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUNoRCxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDaEMsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN0RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMxQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDckQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQ3JDLENBQUMsQ0FBQyxDQUFDO0FBQ0gsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3JCLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3JELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7QUFDekIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3hCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNYLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVE7QUFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMxRCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUM7QUFDRCxLQUFLLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDcEIsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO0FBQ2pDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtB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SUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQztBQUN0QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDaEksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNO0FBQ2pFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUMvRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLFlBQVksQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEdBQUcs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QUMsRUFBRSxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQztBQUN0RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ1gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDMUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNWLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQzdFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDO0FBQ0gsQ0FBQztBQUNEO0FBQ0EsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDeEMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMvQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUIsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMzQixDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztBQUNkLENBQUM7QUFDRCxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsSUFBSSxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1YsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDakIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUMxQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDL0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUNqQixDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ3BCLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ2pCO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDL0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDMUIsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUNYLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDakIsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDZCxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDZixDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUNyQixDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1osQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDbEMsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbEIsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzdCLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQztBQUN6QixDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUNwQixDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDckIsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUNyQixDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDdkMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFDakMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6RSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ25CLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ25DLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFDakIsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbkIsQ0FBQztBQUNEO0FBQ0EsR0FBRyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDaEMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbEIsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDaEIsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFDckIsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDckIsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDeEIsQ0FBQztBQUNEO0FBQ0EsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDeEIsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNoQixDQUFDO0FBQ0Q7QUFDQSxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDOUIsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUNqQixDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2QsQ0FBQztBQUNEO0FBQ0EsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNwQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFDbkIsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFDckIsQ0FBQztBQUNEO0FBQ0EsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ1gsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDeEIsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNWLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuQixDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQztBQUNuQixDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFDeEIsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDZixDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNwQixDQUFDO0FBQ0Q7QUFDQSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDdkIsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3JCLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25CLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztBQUN4QixDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUM7QUFDeEIsQ0FBQztBQUNEO0FBQ0EsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNSLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3ZCLENBQUM7QUFDRDtBQUNBLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDUixDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNsQixDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNwQixDQUFDO0FBQ0Q7QUFDQSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbEIsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ3BCLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuQixDQUFDO0FBQ0Q7QUFDQSxJQUFJLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUN2QixDQUFDO0FBQ0Q7QUFDQSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNaLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQzdCLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDbEIsQ0FBQztBQUNEO0FBQ0EsR0FBRyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNsRyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDckIsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFDbkIsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDcEMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUM1QixDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzFCLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUN6QixDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDO0FBQzlDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ3RCLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsT0FBTyxDQUFDO0FBQ3hCLENBQUM7QUFDRCxDQUFDO0FBQ0QsQ0FBQyxDQUFDO0FBQ0YsS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNWLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzVDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDaEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1osQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUMxQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN0RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDdEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDYixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzFELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDO0FBQy9CLENBQUMsQ0FBQztBQUNGLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoRCxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUMvRCxLQUFLLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO0FBQ2pCLEtBQUssQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3hDLENBQUMsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUNaLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwRCxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDOUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUM7QUFDbEYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMvQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM3RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUMxQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDckIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUMxRCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDakQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDckIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzVCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ1osQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7QUFDaEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ3pDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUM1QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDbkQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDdkMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUN0QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0UsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUc7QUFDL0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDZixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDZCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMs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Q0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDLENBQUM7QUFDakMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO0FBQ3JCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFD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Q0FBQyxFQUFFLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO0FBQ3hCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQy9DLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNqRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQzdDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM3QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDakIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUM7QUFDbkYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUM3RyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUM5QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDN0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN2QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDZCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDOUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3JDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDakMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNiLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNuRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNuRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUN2QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3hELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN4RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDaEosQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUN6QixDQUFDLENBQUMsQ0FB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O0FBQ1YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDaEMsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMzQixDQUFDO0FBQ0QsUUFBUSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQzFCLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDekIsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDO0FBQ0QsUUFBUSxDQUFDLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDdEMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQzlDLENBQUM7QUFDRCxRQUFRLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUM7QUFDMUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0YsQ0FBQztBQUNEO0FBQ0EsTUFBTSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7In0=