/** Find one shared phrase per listing; never split a word or numeric identifier. */
export function namePrefix(names) {
    if (names.length < 2) return 0;
    const first = names[0];
    let end = first.length;
    for (const name of names) {
        let shared = 0;
        while (shared < end && first[shared] === name[shared]) shared++;
        end = shared;
        if (!end) return 0;
    }
    const prefix = first.slice(0, end).match(/^.*[\s._-]/su)?.[0] || '';
    return names.every(name => name.length > prefix.length) ? prefix.length : 0;
}
