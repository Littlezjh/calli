import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVideo, MAX_VIDEO_BYTES, prepareVideo } from '../src/videos.js';

test('mobile videos with missing MIME types are recognized and oversized or unsupported files are rejected', () => {
  assert.equal(isVideo({ name: 'recording.MOV', type: '' }), true);
  assert.equal(isVideo({ name: 'photo.jpg', type: 'image/jpeg' }), false);
  assert.throws(() => prepareVideo({ name: 'big.mp4', type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 } as File), /100 MB/);
  assert.throws(() => prepareVideo(new File([], 'empty.mp4', { type: 'video/mp4' })), /空/);
  assert.throws(() => prepareVideo(new File(['x'], 'clip.avi', { type: 'video/avi' })), /MP4/);
  const file = new File(['video bytes'], 'recording.MOV');
  const prepared = prepareVideo(file);
  assert.equal(prepared.file, file, 'keep the original file, without base64 or transcoding');
  assert.equal(prepared.name, 'recording.MOV');
  URL.revokeObjectURL(prepared.previewUrl);
});
