import fs from 'node:fs'
import path from 'node:path'

// Run after npm ci. Preserve upstream license text when refreshing dependencies.
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const sections = [
  'Folio — Third-party license notices',
  'These notices cover installed production npm dependencies and Electron.\n' +
  'Some optional packages are platform-specific or unused by the final bundle.\n' +
  'Each component remains governed by its own license; Folio’s LICENSE applies\n' +
  'only to original Folio materials. JSZip is used under its MIT option.\n' +
  'Electron’s additional Chromium notices accompany the Electron runtime.\n' +
  'PDF.js font, CMap, ICC, and WebAssembly notices are included below and\n' +
  'also accompany the assets in the application.',
]

function addFile(file, label = file.replace(/^node_modules\//, '')) {
  sections.push(`--- ${label} ---\n\n${fs.readFileSync(file, 'utf8').trim()}`)
}

for (const [directory, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!directory || (metadata.dev && directory !== 'node_modules/electron') || !fs.existsSync(directory)) continue
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  sections.push(`=== ${pkg.name} ${pkg.version} (${metadata.license || pkg.license || 'See license text'}) ===`)
  const licenses = fs.readdirSync(directory).filter(name =>
    /^(licen[cs]e|copying|notice|copyright)/i.test(name) && fs.statSync(path.join(directory, name)).isFile(),
  ).sort()
  if (licenses.length) {
    for (const file of licenses) addFile(path.join(directory, file))
  } else if (pkg.name === 'isarray') {
    const readme = fs.readFileSync(path.join(directory, 'README.md'), 'utf8')
    const start = readme.indexOf('## License')
    if (start < 0) throw new Error('isarray license section missing')
    sections.push(readme.slice(start).trim())
  } else if (pkg.name.startsWith('@napi-rs/canvas-')) {
    addFile('node_modules/@napi-rs/canvas/LICENSE')
  } else {
    throw new Error(`License text missing for ${pkg.name}; review before distributing`)
  }
}

for (const directory of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  const base = `node_modules/pdfjs-dist/${directory}`
  for (const name of fs.readdirSync(base).filter(name => /^LICENSE/i.test(name)).sort()) {
    addFile(path.join(base, name))
  }
}

const notices = sections.join('\n\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
fs.writeFileSync('THIRD_PARTY_LICENSES.txt', `${notices}\n`)
console.log('Updated THIRD_PARTY_LICENSES.txt')
