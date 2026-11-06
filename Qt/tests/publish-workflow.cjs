const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeReleaseTag } = require('../../scripts/release-version.cjs');

function publishConcurrencyTag(tag) {
    return tag.startsWith('v') ? tag : `v${tag}`;
}

for (const tag of ['0.4.2', 'v0.4.2', '1.0.0', 'v10.0.1']) {
    assert.equal(publishConcurrencyTag(tag), normalizeReleaseTag(tag));
}

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/publish.yml'), 'utf8');
assert.match(
    workflow,
    /group: publish-\$\{\{ startsWith\(inputs\.tag, 'v'\) && inputs\.tag \|\| format\('v\{0\}', inputs\.tag\) \}\}/,
);
assert.match(workflow, /cancel-in-progress: false/);
console.log('Equivalent release tags share one publish concurrency group');
