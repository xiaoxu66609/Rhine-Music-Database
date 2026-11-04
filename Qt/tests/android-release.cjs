const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/desktop.yml'), 'utf8');
const android = workflow.slice(workflow.indexOf('android:'));
assert.notEqual(android.indexOf('target: android'), -1);
assert.match(android, /host: all_os/);
assert.doesNotMatch(android, /host: linux/);
console.log('Android Qt 6.12 is installed from the all_os repository');

const result = spawnSync('bash', ['scripts/build-libnode-android.sh', '--self-test'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
});
if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
}
process.stdout.write(result.stdout);
