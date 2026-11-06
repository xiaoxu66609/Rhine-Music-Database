const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/desktop.yml'), 'utf8');
assert.doesNotMatch(workflow, /^  ios:\n/m);
assert.match(workflow, /build-ios: true/);
assert.match(workflow, /if: matrix\.build-ios[\s\S]*npm run build:ios/);
assert.match(workflow, /format\('rhine-macos-15-hosted-\{0\}', github\.repository\)/);
console.log('Unsigned iOS builds on the macOS matrix runner without a second macos-15 job');
