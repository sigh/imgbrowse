import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {metadataInfo, MetadataKind, formatMetadataDate, formatRelativeAge} from '../image_browser/web/static/metadata-data.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const image = {kind:MetadataKind.IMAGE, name:'photo.jpg', filesystem_path:'/media/photo.jpg', archive_member:null,
    width:1600, height:2400, format:'JPEG', size:840000, modified:'2026-09-29T12:00:00Z'};

test('image facts and optional EXIF are prepared without changing source data', () => {
    const data = {...image, exif:{Taken:'2026-09-28T08:42:00', 'Camera make':'Fujifilm', 'Camera model':'X-T5'}};
    const original = structuredClone(data);
    const info = metadataInfo(data, now);
    assert.deepEqual(info.summary.map(({label}) => label), ['Dimensions','Format','Size']);
    assert.equal(info.summary[0].value, '1600 × 2400');
    assert.equal(info.path, '/media/photo.jpg');
    assert.deepEqual(info.rows.map(({label}) => label), ['Modified', 'Taken', 'Camera']);
    const [modified, taken, camera] = info.rows;
    assert.equal(modified.datetime, image.modified);
    assert.equal(modified.age, new Intl.RelativeTimeFormat(undefined, {numeric:'auto'}).format(-5, 'day'));
    assert.equal(taken.value, '2026-09-28 08:42');
    assert.equal(taken.datetime, data.exif.Taken);
    assert.ok(taken.age);
    assert.deepEqual(camera, {label:'Camera', value:'Fujifilm X-T5'});
    assert.deepEqual(data, original);
});

test('container counts describe direct contents and retain zero values', () => {
    const info = metadataInfo({kind:MetadataKind.DIRECTORY, name:'Empty', filesystem_path:'/media/Empty', folders:0, media:0}, now);
    assert.deepEqual(info.summary.map(({value}) => value), ['0 direct media','0 subfolders']);
    assert.deepEqual(info.rows, []);
});

test('archive and member locations retain their physical source and date meaning', () => {
    const archive = {kind:MetadataKind.ARCHIVE, name:'Book.cbz', filesystem_path:'/media/Book.cbz', archive_size:1048576, folders:2, media:18};
    const info = metadataInfo(archive, now);
    assert.equal(info.pathLabel, 'Archive');
    assert.deepEqual(info.rows, [{label:'Archive size', value:'1 MiB'}]);
    const member = metadataInfo({...image, filesystem_path:archive.filesystem_path, archive_member:'Chapter/page.jpg'}, now);
    assert.equal(member.pathLabel, 'Member path');
    assert.equal(member.path, '/media/Book.cbz/Chapter/page.jpg');
    assert.equal(member.rows[0].label, 'Modified');
    const folder = metadataInfo({...archive, kind:MetadataKind.DIRECTORY, archive_member:'Chapter', modified:image.modified}, now);
    assert.equal(folder.rows[0].label, 'Archive date');
});

test('video duration is optional and uses the same format as previews', () => {
    const video = {kind:MetadataKind.VIDEO, name:'clip.webm', filesystem_path:'/media/clip.webm', size:1024};
    assert.deepEqual(metadataInfo(video, now).summary.map(({value}) => value), ['WEBM','1 KiB']);
    assert.deepEqual(metadataInfo({...video, duration:3605}, now).summary.map(({value}) => value), ['1:00:05','WEBM','1 KiB']);
    assert.equal(metadataInfo({...video, duration:0}, now).summary[0].value, '0:00');
});

test('unreadable image details retain path and size without invented facts', () => {
    const info = metadataInfo({kind:MetadataKind.IMAGE, name:'broken.jpg', filesystem_path:'/media/broken.jpg', size:180000,
        modified:'invalid', metadata_error:'Bad image', exif:{Taken:'invalid'}}, now);
    assert.deepEqual(info.summary.map(({label}) => label), ['Size']);
    assert.equal(info.path, '/media/broken.jpg');
    assert.deepEqual(info.rows, []);
    assert.equal(info.status, 'Image details unavailable.');
});

test('Taken and Modified use identical date values and relative ages', () => {
    const info = metadataInfo({...image, exif:{Taken:image.modified}}, now);
    assert.deepEqual(info.rows.map(({label}) => label), ['Modified', 'Taken']);
    const [{label:modifiedLabel, ...modified}, {label:takenLabel, ...taken}] = info.rows;
    assert.deepEqual(taken, modified);
    assert.equal(taken.age, new Intl.RelativeTimeFormat(undefined, {numeric:'auto'}).format(-5, 'day'));
});

test('embedded coordinates produce a readable location and native map destination', () => {
    for (const [latitude, longitude, value] of [[-33.86,151.2,'33.86000° S, 151.20000° E'],
        [40.7,-74,'40.70000° N, 74.00000° W'], [0,0,'0.00000° N, 0.00000° E']]) {
        const info = metadataInfo({...image, location:{latitude, longitude}}, now);
        const location = info.rows.find(row => row.label === 'Location');
        assert.equal(location.value, value);
        const url = new URL(location.href);
        assert.equal(url.origin, 'https://www.openstreetmap.org');
        assert.equal(Number(url.searchParams.get('mlat')), latitude);
        assert.equal(Number(url.searchParams.get('mlon')), longitude);
    }
    assert.equal(metadataInfo(image, now).rows.some(row => row.label === 'Location'), false);
});

test('dates remain unambiguous and relative ages handle past, present and future', () => {
    assert.equal(formatMetadataDate('2005-01-10T17:08:17'), '2005-01-10 17:08');
    assert.equal(formatMetadataDate('invalid'), undefined);
    const relative = new Intl.RelativeTimeFormat(undefined, {numeric:'auto'});
    for (const [seconds, unit, amount] of [[-5*86400,'day',-5], [0,'second',0], [120,'minute',2], [-2*31536000,'year',-2]]) {
        assert.equal(formatRelativeAge(new Date(now+seconds*1000).toISOString(), now), relative.format(amount, unit));
    }
    assert.equal(formatRelativeAge('invalid', now), undefined);
    assert.equal(formatRelativeAge(undefined, now), undefined);
});

test('capture offsets identify one instant across browser timezones', () => {
    const moduleUrl = new URL('../image_browser/web/static/metadata-data.js', import.meta.url).href;
    const script = `import {metadataInfo} from ${JSON.stringify(moduleUrl)};
        const times = ['2026-10-04T10:00:00+02:00', '2026-10-04T02:30:00-05:30'];
        console.log(JSON.stringify(times.map(Taken => metadataInfo({name:'photo.jpg', kind:'image',
            filesystem_path:'/media/photo.jpg', exif:{Taken}}, Date.parse('2026-10-04T12:00:00Z')).rows[0])));`;
    for (const [TZ, value] of [['UTC','2026-10-04 08:00'], ['America/New_York','2026-10-04 04:00'],
        ['Australia/Sydney','2026-10-04 19:00']]) {
        const rows = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
            {env:{...process.env, TZ}, encoding:'utf8'}));
        for (const row of rows) {
            assert.equal(row.value, value, TZ);
            assert.equal(row.age, new Intl.RelativeTimeFormat(undefined, {numeric:'auto'}).format(-4, 'hour'), TZ);
        }
    }
});
