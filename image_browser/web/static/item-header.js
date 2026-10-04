import {folderPath} from './folder-path.js';
import {Breadcrumbs} from './breadcrumbs.js';
import {InfoButton} from './metadata.js';
import {sortKey} from './state.js';

/** One shared header, explicitly owned by the app and used by Browse and reading. */
export class ItemHeader {
    constructor(location, actions, folderLink) {
        this.breadcrumbs = new Breadcrumbs(location.querySelector('.breadcrumbs'), folderLink);
        this.info = new InfoButton(actions);
    }

    update(options) {
        // Native folder links carry the layout and ordering as well as the path.
        const key = JSON.stringify([options.compact, sortKey(options)]);
        this.breadcrumbs.update(folderPath(options), this.linkKey !== key);
        this.linkKey = key;
        this.info.update(options);
    }
}
