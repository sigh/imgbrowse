import {folderPath} from './folder-path.js';
import {Breadcrumbs} from './breadcrumbs.js';
import {InfoButton} from './metadata.js';

/** One shared header, explicitly owned by the app and used by Browse and reading. */
export class ItemHeader {
    constructor(location, actions, folderLink) {
        this.breadcrumbs = new Breadcrumbs(location.querySelector('.breadcrumbs'), folderLink);
        this.info = new InfoButton(actions);
    }

    update(options) {
        // Folder layout changes native link URLs; the path model stays independent of it.
        this.breadcrumbs.update(folderPath(options), this.compact !== options.compact);
        this.compact = options.compact;
        this.info.update(options);
    }
}
