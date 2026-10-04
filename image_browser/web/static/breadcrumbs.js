import {element, setButtonLabel} from './dom.js';
import {PathKind, fitFolderPath} from './folder-path.js';

function separator() {
    const node = element('span', 'breadcrumb-separator', '/');
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function sameItem(a, b) {
    return a.kind === b.kind && a.path === b.path && a.label === b.label
        && a.browsing === b.browsing && a.link === b.link && a.current === b.current;
}

const itemKey = item => item.kind + ':' + (item.kind === PathKind.FILE ? '' : item.path);

/** Render a path model; browser geometry and focus stay within this view. */
export class Breadcrumbs {
    constructor(container, folderLink) {
        this.container = container;
        this.folderLink = folderLink;
        this.name = container.querySelector('.item-name');
        this.rows = [];
        this.menus = [new GapMenu(container.parentElement, `${container.id}-gap-0`)];
        container.tabIndex = -1;
        container.parentElement.addEventListener('keydown', event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation();
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const open = this.menus.find(menu => menu.isOpen);
            if (!open) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            open.close(true);
        }, true);
        new ResizeObserver(() => this.fit()).observe(container);
    }

    update(items, refreshLinks = false) {
        if (!refreshLinks && items.length === this.rows.length && items.every((item, index) => sameItem(item, this.rows[index].item))) return;
        const previous = new Map(this.rows.map(row => [itemKey(row.item), row]));
        this.rows = items.map(item => {
            const old = previous.get(itemKey(item));
            const reuse = old && old.item.link === item.link;
            const node = reuse ? old.node : item.kind === PathKind.FILE ? this.name
                : item.link ? this.folderLink(item.path, item.label) : element('span');
            if (reuse && refreshLinks && item.link) node.href = this.folderLink(item.path, item.label).href;
            node.classList.add('breadcrumb-item');
            if (!reuse) node.replaceChildren(element('span', 'breadcrumb-label'));
            node.firstElementChild.textContent = item.label;
            node.title = item.path || item.label;
            node.classList.toggle('selected-folder', item.browsing);
            if (item.current) node.setAttribute('aria-current', item.current);
            else node.removeAttribute('aria-current');
            if (item.browsing) node.setAttribute('aria-description', 'Browsing folder');
            else node.removeAttribute('aria-description');
            node.hidden = false;
            return {item, node};
        });
        this.fit();
    }

    draw(nodes) {
        const children = [];
        nodes.forEach((node, index) => { if (index) children.push(separator()); children.push(node); });
        this.container.replaceChildren(...children);
    }

    measure() {
        this.container.classList.remove('truncated');
        this.draw(this.rows.map(row => row.node));
        // Measure the actual menu control and CSS spacing, rather than duplicate CSS sizes.
        const button = this.menus[0].button;
        this.container.append(button);
        const widths = this.rows.map(row => row.node.getBoundingClientRect().width);
        const geometry = {
            available:this.container.clientWidth,
            spacing:parseFloat(getComputedStyle(this.container).gap),
            separator:this.container.querySelector('.breadcrumb-separator')?.getBoundingClientRect().width || 0,
            gap:button.getBoundingClientRect().width,
        };
        return {widths, geometry};
    }

    fit() {
        if (!this.rows.length) return;
        const focused = document.activeElement;
        const ownedFocus = this.container.parentElement.contains(focused);
        const href = focused.getAttribute('href');
        this.menus.forEach(menu => menu.close());
        const {widths, geometry} = this.measure();
        const plan = fitFolderPath(this.rows.map(row => row.item), widths, geometry);
        const nodes = new Map(this.rows.map(row => [row.item, row.node]));
        let gapIndex = 0;
        this.draw(plan.parts.map(part => {
            if (part.kind !== PathKind.GAP) return nodes.get(part);
            const index = gapIndex++;
            const menu = this.menus[index] ||= new GapMenu(this.container.parentElement, `${this.container.id}-gap-${index}`);
            menu.nodes = part.items.map(item => nodes.get(item));
            return menu.button;
        }));
        this.container.classList.toggle('truncated', plan.truncated);
        if (ownedFocus) {
            const matches = node => node === focused || href && node.getAttribute('href') === href;
            const visible = this.rows.find(row => this.container.contains(row.node) && matches(row.node));
            const menu = this.menus.find(menu => menu.button.isConnected && (menu.button === focused || menu.nodes.some(matches)));
            (visible?.node || menu?.button || this.container).focus({preventScroll: true});
        }
    }
}

/** Own one gap's popover, positioning and keyboard return; it never decides path policy. */
class GapMenu {
    constructor(host, id) {
        this.nodes = [];
        this.button = element('button', 'breadcrumb-gap', '…');
        this.button.type = 'button';
        setButtonLabel(this.button, 'Hidden folders');
        this.button.setAttribute('aria-controls', id);
        this.button.setAttribute('aria-expanded', 'false');
        this.panel = element('nav', 'breadcrumb-menu');
        this.panel.id = id;
        this.panel.setAttribute('popover', 'auto');
        this.panel.setAttribute('aria-label', this.button.title);
        host.append(this.panel);
        this.button.addEventListener('click', () => this.toggle());
        this.panel.addEventListener('toggle', () => this.button.setAttribute('aria-expanded', String(this.isOpen)));
    }

    get isOpen() { return this.panel.matches(':popover-open'); }

    close(restoreFocus = false) {
        if (!this.isOpen) return;
        this.panel.hidePopover();
        if (restoreFocus) this.button.focus({preventScroll: true});
    }

    toggle() {
        if (this.isOpen) { this.close(true); return; }
        const list = element('ul');
        this.nodes.forEach((node, index) => {
            const row = element('li');
            row.style.setProperty('--depth', index);
            row.append(node);
            list.append(row);
        });
        this.panel.replaceChildren(list);
        this.panel.showPopover();
        const anchor = this.button.getBoundingClientRect();
        this.panel.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - this.panel.offsetWidth - 12))}px`;
        this.panel.style.top = `${anchor.bottom + 6}px`;
        this.panel.style.maxHeight = `${innerHeight - anchor.bottom - 18}px`;
        this.nodes[0].focus({preventScroll: true});
    }
}
