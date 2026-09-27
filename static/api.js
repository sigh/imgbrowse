/** HTTP details live here; views work with folder listings and traversal pages. */
async function request(url, signal, data) {
    const options = {signal};
    if (data !== undefined) {
        options.method = 'POST';
        options.headers = {'Content-Type': 'application/json'};
        options.body = JSON.stringify(data);
    }
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to load this folder');
    return result;
}

export const imageUrl = (path, thumbnail = false) =>
    (thumbnail ? '/thumbnail?' : '/image?') + new URLSearchParams({path});

export const getFolder = (path, signal) =>
    request('/api/folder?' + new URLSearchParams({path}), signal);

export const getPreview = (path, signal) =>
    request('/api/preview?' + new URLSearchParams({path}), signal);

export const walkImages = (options, signal) => request('/api/walk', signal, options);

export async function getThumbnail(path, signal) {
    const response = await fetch(imageUrl(path, true), {signal});
    if (!response.ok) throw new Error('Preview unavailable');
    return response.blob();
}
