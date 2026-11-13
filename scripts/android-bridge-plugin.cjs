const fs = require('node:fs');

// Node 18 的 TextDecoder fatal 选项与上游校验写法不兼容，换成 node:buffer。
module.exports = {
    name: 'android-utf8-validation',
    setup(build) {
        build.onLoad({ filter: /@neteasecloudmusicapienhanced\/api\/util\/crypto\.js$/ }, (args) => {
            const contents = fs.readFileSync(args.path, 'utf8');
            const decoder =
                /const decoder = new TextDecoder\('utf-8', \{ fatal: true \}\)\n\nconst isUtf8 = \(buf\) => \{\n  try \{\n    decoder.decode\(buf\)\n    return true\n  \} catch \{\n    return false\n  \}\n\}/g;
            const matches = [...contents.matchAll(decoder)];
            if (matches.length !== 1 || contents.match(/decoder\./g)?.length !== 1) {
                throw new Error('Upstream UTF-8 validator changed; review Android compatibility before building');
            }
            return {
                contents: contents.replace(decoder, "const { isUtf8 } = require('node:buffer')"),
                loader: 'js',
            };
        });
    },
};
