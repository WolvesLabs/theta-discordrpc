const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['src/main.js'],
    bundle: true,
    outfile: 'main.js',
    platform: 'node',
    target: 'node16',
    external: ['obsidian'],
    format: 'cjs'
}).catch(() => process.exit(1));