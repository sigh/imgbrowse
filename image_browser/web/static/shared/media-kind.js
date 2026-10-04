/** Item classification shared by data loading and presentation. */
export const MetadataKind = Object.freeze({IMAGE:'image', VIDEO:'video', FILE:'file', DIRECTORY:'directory', ARCHIVE:'archive'});

/** Loose video formats accepted by the server; codecs remain browser-dependent. */
export const isVideo = path => /\.(mp4|m4v|webm|ogv|mov)$/i.test(path || '');
export const fileExtension = path => path.match(/\.([^./]+)$/)?.[1].toUpperCase();

export const MediaErrorCode = Object.freeze({ABORTED:1, NETWORK:2, DECODE:3, UNSUPPORTED:4});
export const PreviewErrorCode = Object.freeze({VIDEO_UNAVAILABLE:'video_preview_unavailable'});

/** Decode and unsupported-format errors will not be fixed by downloading again. */
export const canRetryMedia = error => ![MediaErrorCode.DECODE, MediaErrorCode.UNSUPPORTED].includes(error?.code);

export function durationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    return (minutes >= 60 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') : minutes)
        + ':' + String(total % 60).padStart(2, '0');
}
