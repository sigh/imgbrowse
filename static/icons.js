/** Small, consistent outline icons. Accessible names belong to their controls. */
const paths = {
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    brokenImage: '<path d="M9 3H3v18h18v-6M14 3l-3 6 6 2-3 5M3 17l5-5 5 6M18 3l3 3m0-3-3 3"/>',
    thumbnails: '<rect x="2" y="5" width="5" height="14" rx="1"/><rect x="10" y="5" width="5" height="14" rx="1"/><rect x="18" y="5" width="4" height="14" rx="1"/>',
};
export function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${paths[name]}</svg>`;
    return span;
}
