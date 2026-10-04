import {durationLabel} from './media-kind.js';

export const MetadataKind = Object.freeze({IMAGE:'image', VIDEO:'video', DIRECTORY:'directory', ARCHIVE:'archive'});

function bytes(value) {
    if (value < 1024) return `${value} bytes`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let index = -1;
    do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
    return `${value.toLocaleString(undefined, {maximumFractionDigits:2})} ${units[index]}`;
}

/** Local date and 24-hour time, at minute precision. */
export function formatMetadataDate(value) {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, {numeric:'auto'});
const ageUnits = [['year',31536000], ['month',2592000], ['week',604800], ['day',86400], ['hour',3600], ['minute',60], ['second',1]];

export function formatRelativeAge(value, now = Date.now()) {
    if (!value) return undefined;
    const seconds = (new Date(value).getTime() - now) / 1000;
    if (!Number.isFinite(seconds)) return undefined;
    const [unit, length] = ageUnits.find(([, length]) => Math.abs(seconds) >= length) || ageUnits.at(-1);
    return relativeTime.format(Math.trunc(seconds / length), unit);
}

function dateRow(label, datetime, now) {
    const value = formatMetadataDate(datetime);
    return value ? {label, value, datetime, age:formatRelativeAge(datetime, now)} : null;
}

/** Project API metadata into display values; no fetching, DOM or mutable UI state. */
export function metadataInfo(data, now = Date.now()) {
    const summary = [], rows = [];
    const add = (target, label, value) => {
        if (value !== undefined && value !== null && value !== '') target.push({label, value:String(value)});
    };
    if (data.width !== undefined && data.height !== undefined) add(summary, 'Dimensions', `${data.width} × ${data.height}`);
    add(summary, 'Duration', durationLabel(data.duration));
    add(summary, 'Format', data.format || (data.kind === MetadataKind.VIDEO ? data.name.split('.').pop().toUpperCase() : undefined));
    if (data.size !== undefined) add(summary, 'Size', bytes(data.size));
    if (data.media !== undefined) add(summary, 'Contents', `${data.media} direct media`);
    if (data.folders !== undefined) add(summary, 'Subfolders', `${data.folders} subfolders`);
    const modifiedLabel = data.kind === MetadataKind.DIRECTORY && data.archive_member ? 'Archive date' : 'Modified';
    const modified = dateRow(modifiedLabel, data.modified, now);
    if (modified) rows.push(modified);
    if (data.archive_size !== undefined) add(rows, 'Archive size', bytes(data.archive_size));
    const exif = data.exif || {};
    const taken = dateRow('Taken', exif.Taken, now);
    if (taken) rows.push(taken);
    add(rows, 'Camera', [exif['Camera make'], exif['Camera model']].filter(Boolean).join(' '));
    if (data.location) {
        const {latitude, longitude} = data.location;
        const coordinate = (value, directions) => `${Math.abs(value).toFixed(5)}° ${directions[value < 0 ? 1 : 0]}`;
        rows.push({label:'Location', value:`${coordinate(latitude, 'NS')}, ${coordinate(longitude, 'EW')}`,
            href:`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`});
    }
    for (const label of ['Artist', 'Copyright']) add(rows, label, exif[label]);
    return {
        name:data.name,
        path:data.filesystem_path + (data.archive_member ? '/' + data.archive_member : ''),
        pathLabel:data.archive_member ? 'Member path' : data.kind === MetadataKind.ARCHIVE ? 'Archive' : 'Path',
        summary,
        rows,
        status:data.metadata_error ? 'Image details unavailable.' : '',
    };
}
