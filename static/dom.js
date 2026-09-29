/** Small DOM helpers and explicit ownership of abortable work and blob URLs. */
export const byId = id => document.getElementById(id);

export function element(tag, className = '', text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export class TaskScope {
    constructor() {
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.cleanups = [];
    }

    onDispose(cleanup) {
        if (this.signal.aborted) cleanup();
        else this.cleanups.push(cleanup);
    }

    objectUrl(blob) {
        this.signal.throwIfAborted();
        const url = URL.createObjectURL(blob);
        this.onDispose(() => URL.revokeObjectURL(url));
        return url;
    }

    delay(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        this.onDispose(() => clearTimeout(timer));
    }

    dispose() {
        this.controller.abort();
        this.cleanups.splice(0).forEach(cleanup => cleanup());
    }
}
