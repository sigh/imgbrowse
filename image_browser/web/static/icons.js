/** Small, consistent outline icons. Accessible names belong to their controls. */
import {setButtonLabel} from './dom.js';

const paths = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M5 8h2M5 12h2M5 16h2"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    previews: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="m3 8 3-3 4 4m4-1 3-3 4 4M3 19l3-3 4 4m4-1 3-3 4 4"/>',
    list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
    previous: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    first: '<path d="M5 4v16m13-15-7 7 7 7"/>',
    last: '<path d="M19 4v16M6 5l7 7-7 7"/>',
    grid: '<path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"/>',
    video: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 8 6 4-6 4Z"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
    file: '<path d="M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8M8 16h8"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    brokenImage: '<path d="M9 3H3v18h18v-6M14 3l-3 6 6 2-3 5M3 17l5-5 5 6M18 3l3 3m0-3-3 3"/>',
    readerStrip: '<rect x="5" y="2" width="14" height="14" rx="1"/><path d="M3 19h4v3H3zM10 19h4v3h-4zM17 19h4v3h-4z"/>',
    readerSingle: '<rect x="5" y="2" width="14" height="20" rx="1"/>',
    readerScroll: '<path d="M5 1h14v5H5zM5 9h14v6H5zM5 18h14v5H5z"/>',
};
export function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${paths[name]}</svg>`;
    return span;
}

/** Update an icon action's graphic and accessible name together. */
export function setIconButton(button, name, label, title = label) {
    if (button.dataset.icon !== name) {
        button.replaceChildren(icon(name));
        button.dataset.icon = name;
    }
    setButtonLabel(button, label, title);
}
