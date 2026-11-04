const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/desktop.yml'), 'utf8');
const ios = workflow.slice(workflow.indexOf('  ios:'));
assert.match(ios, /needs: build/);
assert.match(ios, /if: \$\{\{ always\(\) && !cancelled\(\) \}\}/);
assert.match(ios, /group: rhine-macos-15-hosted-\$\{\{ github\.repository \}\}/);
console.log('iOS job waits for the desktop matrix but still runs when a leg fails');
