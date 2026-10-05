import {durationLabel, fileExtension, isVideo, MetadataKind} from '../shared/media-kind.js';

function bytes(value) {
    if (value < 1024) return `${value} bytes`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let index = -1;
    do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
    return `${value.toLocaleString(undefined, {maximumFractionDigits:2})} ${units[index]}`;
}

export const timestampValue = date => typeof date === 'string' ? date : date?.value;

const calendarPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
function calendarParts(value) {
    const parts = calendarPattern.exec(value);
    if (!parts) return null;
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    // Validate using UTC solely as calendar arithmetic. Local timezone rules
    // cannot validate a timezone-free value (e.g. a DST gap or skipped day).
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60 ? parts : null;
}

/** Convert instants to local time; retain calendar values exactly as stored. */
export function formatMetadataDate(value) {
    if (!value) return undefined;
    const text = timestampValue(value);
    if (!text) return undefined;
    if (value.kind === 'calendar' || calendarPattern.test(text)) {
        const parts = calendarParts(text);
        return parts ? `${parts[1]}-${parts[2]}-${parts[3]} ${parts[4]}:${parts[5]}` : undefined;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return undefined;
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, {numeric:'auto'});
const ageUnits = [['year',31536000], ['month',2592000], ['week',604800], ['day',86400], ['hour',3600], ['minute',60], ['second',1]];

export function formatRelativeAge(value, now = Date.now()) {
    if (!value) return undefined;
    const text = timestampValue(value);
    if (!text || value.kind === 'calendar' || calendarPattern.test(text)) return undefined;
    const seconds = (new Date(text).getTime() - now) / 1000;
    if (!Number.isFinite(seconds)) return undefined;
    const [unit, length] = ageUnits.find(([, length]) => Math.abs(seconds) >= length) || ageUnits.at(-1);
    return relativeTime.format(Math.trunc(seconds / length), unit);
}

function dateRow(label, datetime, now) {
    const value = formatMetadataDate(datetime);
    return value ? {label, value, datetime:timestampValue(datetime), age:formatRelativeAge(datetime, now)} : null;
}

/** Project API metadata into display values; no fetching, DOM or mutable UI state. */
export function metadataInfo(data, now = Date.now()) {
    const facts = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && value !== '') facts.push({label, value:String(value)});
    };
    if (data.width !== undefined && data.height !== undefined) add('Dimensions', `${data.width} × ${data.height}`);
    add('Duration', durationLabel(data.duration));
    add('Format', data.format || ([MetadataKind.VIDEO, MetadataKind.FILE].includes(data.kind) ? fileExtension(data.name) : undefined));
    if (data.size !== undefined) add('Size', bytes(data.size));
    if (data.media !== undefined) add('Contents', `${data.media} direct media`);
    if (data.folders !== undefined) add('Subfolders', `${data.folders} subfolders`);
    const modified = dateRow('Modified', data.modified, now);
    if (modified) facts.push(modified);
    const containerModified = dateRow('Archive file modified', data.container_modified, now);
    if (containerModified) facts.push(containerModified);
    if (data.archive_size !== undefined) add('Archive size', bytes(data.archive_size));
    const exif = data.exif || {};
    const taken = dateRow('Taken', exif.Taken, now);
    if (taken) facts.push(taken);
    add('Camera', [exif['Camera make'], exif['Camera model']].filter(Boolean).join(' '));
    if (data.location) {
        const {latitude, longitude} = data.location;
        const coordinate = (value, directions) => `${Math.abs(value).toFixed(5)}° ${directions[value < 0 ? 1 : 0]}`;
        facts.push({label:'Location', value:`${coordinate(latitude, 'NS')}, ${coordinate(longitude, 'EW')}`,
            href:`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`});
    }
    for (const label of ['Artist', 'Copyright']) add(label, exif[label]);
    return {
        facts,
        status:data.kind === MetadataKind.FILE
            ? data.archive_member && isVideo(data.name) ? 'Videos inside archives cannot be viewed.' : 'This file type cannot be viewed.'
            : data.video_pending ? 'Loading video details…'
            : data.video_error ? 'Video details unavailable.'
            : data.metadata_error ? 'Image details unavailable.' : '',
    };
}
