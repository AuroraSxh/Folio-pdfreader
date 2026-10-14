import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chatImageFilename, inspectChatImageBytes, MAX_CHAT_IMAGE_BYTES, validateDraftChatImages, validateStoredChatImages } from '../shared/images';
import { imageDraft, pngChunk, syntheticJPEG, syntheticPNG } from './image-fixtures';

test('browser-safe image validation inspects actual PNG/JPEG bytes, dimensions and canonical drafts', () => {
  for (const [bytes, mime] of [[syntheticPNG(), 'image/png'], [syntheticJPEG, 'image/jpeg']] as const) {
    const result = validateDraftChatImages([{ ...imageDraft(bytes, mime), name: '  Figure 1  ' }])[0];
    assert.equal(result.name, 'Figure 1'); assert.equal(result.mimeType, mime); assert.equal(result.width, 8); assert.equal(result.height, 6); assert.equal(result.byteSize, bytes.length);
    assert.deepEqual(result.bytes, new Uint8Array(bytes));
    assert.equal(chatImageFilename({ id: randomUUID(), mimeType: mime }).endsWith(mime === 'image/png' ? '.png' : '.jpg'), true);
  }
  assert.deepEqual(validateDraftChatImages(undefined), []); assert.deepEqual(validateDraftChatImages([]), []);
});
test('rejects URLs, SVG, data MIME spoofing, malformed base64, corrupted/truncated bytes and animations', () => {
  const png = syntheticPNG(), broken = Buffer.from(png); broken[40] ^= 1;
  const animation = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), png.subarray(33)]);
  for (const draft of [
    { name:'x', dataUrl:'https://example.com/figure.png' }, { name:'x', dataUrl:'file:///tmp/image.png' },
    { name:'x', dataUrl:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, imageDraft(png, 'image/jpeg'), imageDraft(syntheticJPEG, 'image/png'),
    imageDraft(broken), imageDraft(png.subarray(0, png.length - 1)), imageDraft(animation),
    { ...imageDraft(), dataUrl: imageDraft().dataUrl + '\n' }, { ...imageDraft(), dataUrl: imageDraft().dataUrl.slice(0, -1) },
    { ...imageDraft(), bytes: png }, { ...imageDraft(), name:'data:image/png;base64,AAAA' },
  ]) assert.throws(() => validateDraftChatImages([draft]));
});
test('bounds dimensions and image count before pixel decode and enforces both byte budgets', () => {
  assert.throws(() => validateDraftChatImages(Array.from({ length: 5 }, () => imageDraft())), /4/);
  assert.throws(() => inspectChatImageBytes(syntheticPNG(2049, 1)), /2048/);
  const largeJPEG = Buffer.from(syntheticJPEG), start = largeJPEG.indexOf(Buffer.from([255,192])); largeJPEG.writeUInt16BE(30000, start + 7);
  assert.throws(() => inspectChatImageBytes(largeJPEG), /2048/);
  assert.throws(() => validateDraftChatImages([{ name:'huge', dataUrl:'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 40) }]), /超限/);
  const padded = imageDraft(syntheticPNG(1, 1, 2 * 1024 * 1024));
  assert.throws(() => validateDraftChatImages([padded, padded, padded, padded]), /8 MiB/);
});
test('new source snapshots belong to the current PDF and page; rectangles must be finite PDF-space bounds', () => {
  const documents = [{ id:'paper', name:'Paper.pdf', pageCount:3 }], source = { documentId:'paper', documentName:'Paper.pdf', page:2, rect:[-5,-2,20,40] };
  assert.equal(validateDraftChatImages([{ ...imageDraft(), source }], documents)[0].source?.page, 2);
  for (const bad of [{...source,documentId:'../paper'}, {...source,documentId:'other'}, {...source,page:4}, {...source,page:0}, {...source,page:1.2}, {...source,rect:[0,0,Infinity,10]}, {...source,rect:[5,0,1,10]}, {...source,rect:[0,0,1]}, {...source,rect:[0,0,1e7,10]}]) assert.throws(() => validateDraftChatImages([{...imageDraft(),source:bad}], documents));
  assert.throws(() => validateDraftChatImages([{...imageDraft(),source}], [{...documents[0],pageCount:0}]));
});
test('stored records forbid data URLs/path fields, ambiguous IDs, duplicate records and invalid numeric metadata', () => {
  const {mimeType,width,height,byteSize}=inspectChatImageBytes(syntheticPNG()), stored={id:randomUUID(),name:'Figure',mimeType,width,height,byteSize};
  validateStoredChatImages([stored]);
  for (const value of [[{...stored,id:'../../image'}], [{...stored,id:stored.id.toUpperCase()}], [{...stored,width:'8'}], [{...stored,byteSize:Infinity}], [{...stored,dataUrl:imageDraft().dataUrl}], [{...stored,path:'/tmp/private'}], [stored,stored]]) assert.throws(() => validateStoredChatImages(value));
  // Kept historical source does not require the original PDF to still exist.
  validateStoredChatImages([{...stored,source:{documentId:'detached',documentName:'Removed original.pdf',page:1}}]);
});
