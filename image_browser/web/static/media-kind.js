/** Loose video formats accepted by the server; codecs remain browser-dependent. */
export const isVideo = path => /\.(mp4|m4v|webm|ogv|mov)$/i.test(path || '');

export const MediaErrorCode = Object.freeze({ABORTED:1, NETWORK:2, DECODE:3, UNSUPPORTED:4});

/** Decode and unsupported-format errors will not be fixed by downloading again. */
export const canRetryMedia = error => ![MediaErrorCode.DECODE, MediaErrorCode.UNSUPPORTED].includes(error?.code);
