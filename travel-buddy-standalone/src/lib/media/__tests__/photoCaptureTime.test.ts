import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {photoCaptureTime} from '../photoCaptureTime.ts';
import {normalizeForUploadWith} from '../normalizeUpload.core.ts';

describe('original photo capture metadata across normalization', () => {
  it('converts the original offset across midnight without using the current device timezone', () => {
    assert.equal(photoCaptureTime({DateTimeOriginal:'2026:03:04 00:15:00',OffsetTimeOriginal:'+05:30'}),'2026-03-03T18:45:00.000Z');
    assert.equal(photoCaptureTime({DateTimeOriginal:'2026:03:04 23:15:00',OffsetTimeOriginal:'-04:00'}),'2026-03-05T03:15:00.000Z');
  });
  it('does not invent an instant from missing timezone, upload time, malformed dates or calendar rollover', () => {
    for (const exif of [null,{}, {DateTimeOriginal:'2026:03:04 00:15:00'}, {DateTime:'2026:03:04 00:15:00',OffsetTime:'+00:00'}, {DateTimeOriginal:'2026:02:30 00:15:00',OffsetTimeOriginal:'+00:00'}, {DateTimeOriginal:'2026:03:04 00:15:00',OffsetTimeOriginal:'+14:30'}]) assert.equal(photoCaptureTime(exif),null);
  });
  it('HEIC, JPEG, PNG and WebP conversion retain only the capture instant, including another normalization on retry',async()=>{
    for(const mimeType of ['image/heic','image/jpeg','image/png','image/webp']) {
      const deps={manipulate:async()=>({uri:'file:///converted',width:100,height:80}),fileSize:async()=>100};
      const first=await normalizeForUploadWith({uri:'file:///original',mimeType,exif:{DateTimeOriginal:'2026:03:04 05:06:07',OffsetTimeOriginal:'+00:00',GPSLatitude:51.5,Model:'private-camera'}},deps);
      assert.equal(first.photoCapturedAt,'2026-03-04T05:06:07.000Z');assert.equal(first.exif,null);
      const retry=await normalizeForUploadWith(first,deps);assert.equal(retry.photoCapturedAt,first.photoCapturedAt);assert.equal(retry.exif,null);
    }
  });
});
