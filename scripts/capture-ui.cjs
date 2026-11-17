const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'analysis', 'scientia-ui-preview.png');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    backgroundColor: '#e7e9ed',
    webPreferences: { offscreen: true },
  });
  await window.loadFile(path.join(root, 'app', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const image = await window.webContents.capturePage();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, image.toPNG());
  console.log(output);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
