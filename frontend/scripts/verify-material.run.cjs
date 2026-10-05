// 打包并运行耗材编排的规则验证脚本：node scripts/verify-material.run.js
const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const outfile = path.join(__dirname, '.verify-material.cjs')

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'verify-material.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    alias: { '@': path.join(root, 'src') },
  })
  .then(() => {
    require(outfile)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
