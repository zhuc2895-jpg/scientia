const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'analysis', 'scientia-agent-result-preview.png');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 920, show: false, webPreferences: { offscreen: true } });
  await window.loadFile(path.join(root, 'app', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await window.webContents.executeJavaScript(`
    document.querySelector('#starter-grid [data-prompt]').click();
    document.querySelector('#send-button').click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  console.log(output);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
