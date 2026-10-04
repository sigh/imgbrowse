import {getFolder, onFolderListing} from './api.js';
import {byId, element, plainClick} from './dom.js';
import {setIconButton} from './icons.js';
import {currentFolder, joinPath, parentPath, ScreenMode, sortKey} from './state.js';

const OVERSCAN = 3;
const TYPEAHEAD_INTERVAL = 700;

/** One folder navigator shared by browsing and reading. Listings never imply expansion. */
export class FolderTree {
    constructor({destination, select, closeTransient}) {
        Object.assign(this, {destination, select, closeTransient});
        this.pane = byId('folder-tree');
        this.list = this.pane.querySelector('ul');
        this.toggle = byId('folders-toggle');
        this.narrow = matchMedia('(max-width: 700px)');
        this.rowHeight = parseFloat(getComputedStyle(this.pane).getPropertyValue('--control-height'));
        this.listings = new Map();
        this.expanded = new Set();
        this.pending = new Map();
        this.errors = new Set();
        this.rows = [];
        this.mounted = new Map();
        this.focused = '';
        this.position = {top: 0, left: 0};
        this.initialized = false;
        onFolderListing((path, folders) => {
            if (this.listings.get(path) === folders) return;
            this.listings.set(path, folders);
            if (!folders.length) this.expanded.delete(path);
            if (!this.pane.hidden) this.rebuild();
        });
        this.toggle.addEventListener('click', () => this.setOpen(this.pane.hidden));
        this.pane.addEventListener('click', event => this.onClick(event));
        this.pane.addEventListener('keydown', event => this.onKey(event));
        this.pane.addEventListener('focusin', event => {
            const row = event.target.closest('.tree-row');
            if (row) { this.focused = row.dataset.path; this.renderRows(); }
        });
        this.pane.addEventListener('scroll', () => this.scheduleRows());
        new ResizeObserver(() => this.scheduleRows()).observe(this.pane);
        document.addEventListener('click', event => {
            if (this.narrow.matches && !this.pane.hidden && !this.pane.contains(event.target)
                && !this.toggle.contains(event.target)) this.setOpen(false, false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !document.fullscreenElement && !this.pane.hidden
                && (this.narrow.matches || this.pane.contains(event.target))) {
                event.preventDefault(); event.stopImmediatePropagation();
                this.setOpen(false);
            }
        }, true);
    }

    get current() { return currentFolder(this.state); }
    canExpand(path) { return !this.listings.has(path) || this.listings.get(path).length > 0; }

    update(state, rootName) {
        this.state = state;
        const key = JSON.stringify([state.mode, this.current, state.layout, state.size, state.compact, sortKey(state), rootName]);
        this.rootName = rootName;
        if (key === this.key) return;
        this.key = key;
        if (!this.pane.hidden) this.rebuild();
    }

    async setOpen(open, focus = true) {
        if (open === !this.pane.hidden) return;
        if (!open) {
            this.position = {top: this.pane.scrollTop, left: this.pane.scrollLeft};
            this.stopRequests();
        } else if (this.narrow.matches) this.closeTransient();
        this.pane.hidden = !open;
        this.toggle.setAttribute('aria-expanded', String(open));
        if (!this.narrow.matches) sessionStorage.setItem('foldersOpen', open ? '1' : '0');
        if (!open) { if (focus) this.toggle.focus({preventScroll: true}); return; }
        const first = !this.initialized;
        this.initialized = true;
        this.rebuild();
        this.pane.scrollTop = this.position.top;
        this.pane.scrollLeft = this.position.left;
        if (first) {
            const path = await this.revealInitialPath();
            if (focus && !this.pane.hidden && document.activeElement === this.toggle) this.focusRow(path, true);
        } else {
            if (focus) this.focusRow(this.focused);
            for (const path of this.expanded) {
                if (this.pane.hidden) break;
                if (!this.listings.has(path)) await this.load(path);
            }
        }
    }

    async revealInitialPath() {
        let path = '';
        const current = this.current;
        const parts = current.split('/').filter(Boolean);
        this.expanded.add(path);
        await this.load(path);
        for (const name of parts) {
            if (this.pane.hidden || !this.listings.get(path)?.includes(name)) break;
            this.expanded.add(path);
            path = joinPath(path, name);
            if (path !== current) await this.load(path);
        }
        this.rebuild();
        return path;
    }

    load(path) {
        if (this.listings.has(path)) return Promise.resolve(this.listings.get(path));
        if (this.pending.has(path)) return this.pending.get(path).promise;
        const task = {controller: new AbortController()};
        this.pending.set(path, task);
        this.errors.delete(path);
        this.rebuild();
        task.promise = getFolder(path, task.controller.signal).then(listing => listing.folders).catch(error => {
            if (error.name !== 'AbortError') this.errors.add(path);
        }).finally(() => {
            if (this.pending.get(path) === task) {
                this.pending.delete(path);
                this.rebuild();
            }
        });
        return task.promise;
    }

    stopRequests() {
        for (const task of this.pending.values()) task.controller.abort();
        this.pending.clear();
    }

    async refresh() {
        this.stopRequests();
        this.listings.clear(); this.errors.clear();
        if (this.pane.hidden) return;
        for (const path of this.expanded) {
            if (this.pane.hidden) break;
            await this.load(path);
        }
        this.rebuild();
    }

    toggleBranch(path) {
        this.focused = path;
        if (this.expanded.has(path)) {
            this.expanded.delete(path);
        } else if (this.canExpand(path)) {
            this.expanded.add(path);
            this.load(path);
        }
        this.rebuild();
        this.focusRow(path);
    }

    onClick(event) {
        if (!plainClick(event)) return;
        const row = event.target.closest('li');
        if (!row) return;
        this.focused = row.dataset.path;
        if (event.target.closest('.tree-disclosure')) {
            event.preventDefault(); event.stopPropagation();
            this.toggleBranch(row.dataset.path);
        } else if (event.target.closest('.tree-retry')) {
            event.preventDefault(); event.stopPropagation();
            this.load(row.dataset.path);
        } else if (event.target.closest('a')) {
            event.preventDefault(); event.stopPropagation();
            if (this.focused === this.current) {
                // Single clicks toggle; the second click of a double-click expands.
                if (event.detail < 2 || !this.expanded.has(this.focused)) this.toggleBranch(this.focused);
                else this.focusRow(this.focused);
                return;
            }
            this.select(this.focused, event.target.closest('a'));
            if (this.narrow.matches) {
                this.setOpen(false, false);
                byId(this.state.mode === ScreenMode.VIEW ? 'viewer-canvas' : 'grid-viewport').focus({preventScroll: true});
            } else this.focusRow(this.focused);
        }
    }

    rebuild() {
        if (this.pane.hidden) return;
        const hadFocus = this.pane.contains(document.activeElement);
        this.rows = [];
        const visit = (path, name, parent = null, sibling = 0, count = 1) => {
            const row = {path, name, parent, depth: parent ? parent.depth + 1 : 0, sibling, count};
            this.rows.push(row);
            if (!this.expanded.has(path)) return;
            if (this.pending.has(path) || this.errors.has(path)) {
                this.rows.push({...row, status: this.pending.has(path) ? 'Loading…' : 'Unable to read folder.', retry: this.errors.has(path)});
            }
            const folders = this.listings.get(path) || [];
            folders.forEach((name, index) => visit(joinPath(path, name), name, row, index, folders.length));
        };
        visit('', this.rootName);
        while (this.focused && !this.rows.some(row => !row.status && row.path === this.focused)) this.focused = parentPath(this.focused);
        this.list.style.height = this.rows.length * this.rowHeight + 'px';
        this.list.replaceChildren(); this.mounted.clear();
        this.renderRows();
        if (hadFocus) this.focusRow(this.focused);
    }

    renderRows() {
        if (this.pane.hidden) return;
        const start = Math.max(0, Math.floor(this.pane.scrollTop / this.rowHeight) - OVERSCAN);
        const end = Math.min(this.rows.length, Math.ceil((this.pane.scrollTop + this.pane.clientHeight) / this.rowHeight) + OVERSCAN);
        const indexes = new Set(Array.from({length: end - start}, (_, index) => start + index));
        const focusedIndex = this.rows.findIndex(row => !row.status && row.path === this.focused);
        if (focusedIndex >= 0) indexes.add(focusedIndex);
        for (const [index, node] of this.mounted) {
            if (!indexes.has(index)) { node.remove(); this.mounted.delete(index); }
        }
        for (const index of indexes) {
            const row = this.rows[index];
            let node = this.mounted.get(index);
            if (!node) {
                node = this.createRow(row);
                node.style.top = index * this.rowHeight + 'px';
                this.mounted.set(index, node); this.list.append(node);
            }
            const link = node.querySelector('a');
            if (link) link.tabIndex = row.path === this.focused ? 0 : -1;
        }
    }

    scheduleRows() {
        if (this.scrollScheduled) return;
        this.scrollScheduled = true;
        requestAnimationFrame(() => { this.scrollScheduled = false; this.renderRows(); });
    }

    createRow(row) {
        const node = element('li', row.status ? 'tree-status' : 'tree-row');
        node.dataset.path = row.path;
        node.style.setProperty('--depth', row.depth);
        node.setAttribute('role', 'none');
        this.addGuides(node, row);
        if (row.status) {
            const status = element('span', '', row.status);
            status.setAttribute('role', 'status');
            node.append(status);
            if (row.retry) node.append(element('button', 'tree-retry', 'Retry'));
            return node;
        }
        const expandable = this.canExpand(row.path);
        const disclosure = element(expandable ? 'button' : 'span', 'tree-disclosure');
        if (expandable) {
            disclosure.tabIndex = -1;
            const expanded = this.expanded.has(row.path);
            setIconButton(disclosure, expanded ? 'down' : 'next', (expanded ? 'Collapse ' : 'Expand ') + row.name);
        } else disclosure.setAttribute('aria-hidden', 'true');
        const link = element('a');
        link.href = this.destination(row.path);
        link.title = row.path || this.rootName;
        link.setAttribute('role', 'treeitem');
        link.setAttribute('aria-level', row.depth + 1);
        link.setAttribute('aria-posinset', row.sibling + 1);
        link.setAttribute('aria-setsize', row.count);
        if (row.path === this.current) link.setAttribute('aria-current', 'page');
        if (expandable) link.setAttribute('aria-expanded', String(this.expanded.has(row.path)));
        link.append(element('span', '', row.name));
        node.append(disclosure, link);
        return node;
    }

    addGuides(node, row) {
        const guide = (depth, classes = '') => {
            const line = element('span', 'tree-guide ' + classes);
            line.style.setProperty('--depth', depth); line.setAttribute('aria-hidden', 'true');
            node.append(line);
        };
        if (!row.status && row.parent) guide(row.depth - 1, 'branch'
            + (row.sibling === row.count - 1 ? ' last' : '') + (this.canExpand(row.path) ? '' : ' leaf'));
        for (let ancestor = row.status ? row : row.parent; ancestor?.parent; ancestor = ancestor.parent) {
            if (ancestor.sibling !== ancestor.count - 1) guide(ancestor.depth - 1);
        }
    }

    focusRow(path, reveal = false) {
        this.focused = path;
        this.renderRows();
        const node = [...this.mounted.values()].find(node => node.classList.contains('tree-row') && node.dataset.path === path);
        node?.querySelector('a').focus({preventScroll: true});
        if (reveal) node?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }

    onKey(event) {
        if (event.key === 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
        event.stopPropagation();
        const rows = this.rows.filter(row => !row.status);
        const index = rows.findIndex(row => row.path === this.focused);
        const row = rows[index];
        let target;
        switch (event.key) {
            case 'ArrowDown': target = rows[Math.min(index + 1, rows.length - 1)]; break;
            case 'ArrowUp': target = rows[Math.max(0, index - 1)]; break;
            case 'Home': target = rows[0]; break;
            case 'End': target = rows.at(-1); break;
            case 'ArrowRight':
                if (!this.expanded.has(row.path)) this.toggleBranch(row.path);
                else if (this.errors.has(row.path)) this.load(row.path);
                else if (rows[index + 1]?.parent?.path === row.path) target = rows[index + 1];
                break;
            case 'ArrowLeft':
                if (this.expanded.has(row.path)) this.toggleBranch(row.path);
                else target = row.parent;
                break;
            default:
                if (event.key.length !== 1) return;
                this.prefix = (performance.now() - (this.typedAt || 0) < TYPEAHEAD_INTERVAL ? this.prefix || '' : '') + event.key.toLocaleLowerCase();
                this.typedAt = performance.now();
                target = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row => row.name.toLocaleLowerCase().startsWith(this.prefix));
        }
        event.preventDefault();
        if (target) this.focusRow(target.path, true);
    }
}
