import assert from 'node:assert/strict';
import test from 'node:test';
import { isApplicationURL, localFileURL, pdfDialogOptions, pdfPathsFromArguments, sameLocalPath } from '../electron/desktop';
import { safeFilename } from '../electron/store';

test('Windows PDF picker selects files, explicit folder picker selects folders, Mac retains mixed picker',()=>{
  assert.deepEqual(pdfDialogOptions('mixed','win32').properties,['openFile','multiSelections']);
  assert.deepEqual(pdfDialogOptions('folder','win32').properties,['openDirectory']);
  assert.deepEqual(pdfDialogOptions('mixed','darwin').properties,['openFile','openDirectory','multiSelections']);
});

test('Windows drive and UNC PDF URLs preserve spaces, Unicode and reserved URL characters',()=>{
  assert.equal(localFileURL('C:\\Users\\A B\\论文#1.pdf','win32'),'file:///C:/Users/A%20B/%E8%AE%BA%E6%96%87%231.pdf');
  assert.equal(localFileURL('\\\\server\\papers\\A B.pdf','win32'),'file://server/papers/A%20B.pdf');
  assert.equal(localFileURL('/Users/A B/论文#1.pdf','darwin'),'file:///Users/A%20B/%E8%AE%BA%E6%96%87%231.pdf');
});

test('application URL checks handle Windows paths and reject other local files and lookalike dev origins',()=>{
  const filename='C:\\Program Files\\Folio\\resources\\app.asar\\dist\\index.html';
  assert.equal(isApplicationURL('file:///C:/Program%20Files/Folio/resources/app.asar/dist/index.html#reader',filename,undefined,'win32'),true);
  assert.equal(isApplicationURL('file:///c:/program%20files/folio/resources/app.asar/dist/index.html',filename,undefined,'win32'),true);
  assert.equal(isApplicationURL('file:///C:/Users/Other/evil.html',filename,undefined,'win32'),false);
  assert.equal(isApplicationURL('https://attacker.test/index.html',filename,undefined,'win32'),false);
  assert.equal(isApplicationURL('http://127.0.0.1:5173/reader',filename,'http://127.0.0.1:5173','win32'),true);
  assert.equal(isApplicationURL('http://127.0.0.1:51730/reader',filename,'http://127.0.0.1:5173','win32'),false);
});

test('Explorer and command-line PDF arguments resolve against launching working directory',()=>{
  const files=pdfPathsFromArguments(['C:\\Program Files\\Folio\\Folio.exe','--flag','paper.PDF','"C:\\Papers\\Other.pdf"','file:///C:/Papers/Third%20paper.pdf','https://example.org/remote.pdf','notes.txt'],'C:\\Research','win32');
  assert.deepEqual(files,['C:\\Research\\paper.PDF','C:\\Papers\\Other.pdf','C:\\Papers\\Third paper.pdf']);
  assert.equal(sameLocalPath('C:\\Research\\paper.pdf','c:/research/PAPER.pdf','win32'),true);
  assert.equal(sameLocalPath('/Research/paper.pdf','/Research/PAPER.pdf','darwin'),false);
});

test('export filenames avoid Windows device names, trailing dots and oversized Unicode components',()=>{
  assert.equal(safeFilename('CON'),'_CON');assert.equal(safeFilename('LPT1.txt'),'_LPT1.txt');assert.equal(safeFilename('COM¹'),'_COM¹');
  assert.equal(safeFilename('A paper...  '),'A paper');assert.equal(safeFilename('normal title'),'normal title');
  assert.ok(Buffer.byteLength(safeFilename('论文'.repeat(100)))<=200);
});
