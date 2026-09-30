/** Loose video formats accepted by the server; codecs remain browser-dependent. */
export const isVideo = path => /\.(mp4|m4v|webm|ogv|mov)$/i.test(path || '');
