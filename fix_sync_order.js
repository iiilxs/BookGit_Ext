const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');

const oldLines = [
  '    // \u2605 \u8fdc\u7a0b\u6570\u636e\u4e5f\u5148\u53bb\u91cd\u518d\u6bd4\u8f83',
  '    const remoteData = dedupBookmarksData(remote.data);',
  '    const remoteCount = countBookmarks(remoteData);',
  '    const remoteChecksum = await sha256(stripExp(remoteData));',
  '',
  '    // ---- \u4e24\u8fb9\u4e00\u81f4 ----',
  '    if (localChecksum === remoteChecksum) {',
  '      return { status: \'success\', message: `\u5df2\u662f\u6700\u65b0\uff08${localCount} \u4e2a\u4e66\u7b7e\uff09`, count: localCount };',
  '    }',
  '',
  '    // ==================== \u4e0a\u4f20\u6a21\u5f0f ====================',
];

const newLines = [
  '    // \u2605 \u8fdc\u7a0b\u6570\u636e\u4e5f\u5148\u53bb\u91cd\u518d\u6bd4\u8f83',
  '    const remoteData = dedupBookmarksData(remote.data);',
  '    const remoteCount = countBookmarks(remoteData);',
  '    const remoteChecksum = await sha256(stripExp(remoteData));',
  '',
  '    // ==================== \u4e0a\u4f20\u6a21\u5f0f\uff08\u603b\u662f\u6267\u884c\uff09====================',
];

const oldStr = oldLines.join('\n');
const newStr = newLines.join('\n');

if (src.includes(oldStr)) {
  src = src.replace(oldStr, newStr);
  fs.writeFileSync(process.argv[2], src, 'utf8');
  console.log('FIXED: first block moved');
} else {
  console.log('First block not found or already fixed');
}

// Second block: download mode before checksum
const oldLines2 = [
  '    // ==================== \u4e0b\u8f7d\u6a21\u5f0f ====================',
];

const newLines2 = [
  '    // ==================== \u4e0b\u8f7d\u6a21\u5f0f\uff08\u603b\u662f\u6267\u884c\uff09====================',
];

const oldStr2 = oldLines2.join('\n');
const newStr2 = newLines2.join('\n');

if (src.includes(oldStr2)) {
  src = src.replace(oldStr2, newStr2);
}

// Check if the smart merge comment is after download mode
const afterDownload = [
  '      return { status: \'success\', message: `\u5df2\u4ece\u8fdc\u7a0b\u4e0b\u8f7d${detail}`, createdCount, count: verify.bookmarks };',
  '    }',
  '',
  '    // ==================== \u667a\u80fd\u5408\u5e76\uff08\u9ed8\u8ba4\uff09====================',
  '    const remoteUrls = collectUrlsFromTree(remoteData);',
];

const afterDownloadStr = afterDownload.join('\n');

if (src.includes(afterDownloadStr)) {
  // Insert checksum check before merge section
  const checksumBlock = [
    '    // ==================== \u667a\u80fd\u5408\u5e76 ====================',
    '    // ---- \u4e24\u8fb9\u4e00\u81f4\uff08\u4ec5\u5408\u5e76\u6a21\u5f0f\u53ef\u8d70\u5feb\u6377\u8def\u5f84\uff09----',
    '    if (localChecksum === remoteChecksum) {',
    "      return { status: 'success', message: `\u5df2\u662f\u6700\u65b0\uff08${localCount} \u4e2a\u4e66\u7b7e\uff09`, count: localCount };",
    '    }',
  ].join('\n');
  
  src = src.replace(
    '    // ==================== \u667a\u80fd\u5408\u5e76\uff08\u9ed8\u8ba4\uff09====================',
    checksumBlock
  );
  console.log('FIXED: moved checksum check to merge section');
}

fs.writeFileSync(process.argv[2], src, 'utf8');
console.log('DONE');
