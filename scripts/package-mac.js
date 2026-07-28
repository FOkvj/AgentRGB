#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const root = path.resolve(__dirname, '..')
const electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
const distDir = path.join(root, 'dist')
const outputApp = path.join(distDir, 'AgentBoard.app')
const resourcesDir = path.join(outputApp, 'Contents', 'Resources')
const appDir = path.join(resourcesDir, 'app')
const iconFile = path.join(root, 'assets', 'app-icon.icns')
const plist = path.join(outputApp, 'Contents', 'Info.plist')
const macosDir = path.join(outputApp, 'Contents', 'MacOS')
const electronBinary = path.join(macosDir, 'Electron')
const appBinary = path.join(macosDir, 'AgentBoard')

if (!fs.existsSync(electronApp)) {
  console.error('Electron.app not found. Run npm install first.')
  process.exit(1)
}

childProcess.execFileSync('python3', [path.join(root, 'scripts', 'generate-icon.py')])

fs.rmSync(outputApp, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })
childProcess.execFileSync('ditto', [electronApp, outputApp])
fs.rmSync(appDir, { recursive: true, force: true })
fs.rmSync(path.join(resourcesDir, 'default_app.asar'), { force: true })
fs.mkdirSync(appDir, { recursive: true })

for (const item of ['main.js', 'preload.js', 'renderer', 'hooks', 'assets', 'scripts']) {
  fs.cpSync(path.join(root, item), path.join(appDir, item), { recursive: true })
}
fs.copyFileSync(iconFile, path.join(resourcesDir, 'AgentBoard.icns'))

fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'agent-board',
  productName: 'AgentBoard',
  version: '1.0.0',
  main: 'main.js',
}, null, 2))

function setPlist(key, value) {
  childProcess.execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
}

setPlist('CFBundleName', 'AgentBoard')
setPlist('CFBundleDisplayName', 'AgentBoard')
setPlist('CFBundleIdentifier', 'com.agentboard.app')
setPlist('CFBundleIconFile', 'AgentBoard.icns')

if (fs.existsSync(electronBinary)) {
  fs.renameSync(electronBinary, appBinary)
  setPlist('CFBundleExecutable', 'AgentBoard')
}

childProcess.execFileSync('xattr', ['-cr', outputApp])
childProcess.execFileSync('codesign', ['--force', '--deep', '--sign', '-', outputApp])

console.log(`✓ Packaged ${outputApp}`)
