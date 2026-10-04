import {folderPath} from './folder-path.js';
import {Breadcrumbs} from './breadcrumbs.js';
import {sortKey} from './state.js';

/** One shared header, explicitly owned by the app and used by Browse and reading. */
export class ItemHeader {
    constructor(location, folderLink) {
        this.breadcrumbs = new Breadcrumbs(location.querySelector('.breadcrumbs'), folderLink);
    }

    update(options) {
        // Native folder links carry the layout and ordering as well as the path.
        const key = JSON.stringify([options.compact, sortKey(options)]);
        this.breadcrumbs.update(folderPath(options), this.linkKey !== key);
        this.linkKey = key;
    }

    onEscape(event) { this.breadcrumbs.onEscape(event); }
}
