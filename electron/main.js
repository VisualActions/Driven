const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

let serverProcess = null;
let mainWindow = null;
let serverUrl = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getOrCreateSecret(userDataDir) {
  const file = path.join(userDataDir, 'secret.key');
  try {
    const buf = fs.readFileSync(file, 'utf8').trim();
    if (buf.length >= 32) return buf;
  } catch {}
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

async function startServer() {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await findFreePort();
  const secret = getOrCreateSecret(userDataDir);
  const dbPath = path.join(userDataDir, 'driven.db');
  serverUrl = `http://127.0.0.1:${port}`;

  const serverPath = path.join(__dirname, '..', 'server.js');
  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      JWT_SECRET: secret,
      DB_PATH: dbPath,
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
    },
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => console.log('Server exited:', code));
}

function waitForServer(retries = 80) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const req = require('http').get(serverUrl + '/healthz', (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry(left);
      }).on('error', () => retry(left));
      req.setTimeout(500, () => req.destroy());
    };
    const retry = (left) => {
      if (left <= 0) return reject(new Error('Server failed to start'));
      setTimeout(() => tryOnce(left - 1), 250);
    };
    tryOnce(retries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#313338',
    title: 'Driven',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(serverUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  await startServer();
  try {
    await waitForServer();
  } catch (e) {
    console.error(e);
  }
  createWindow();
  Menu.setApplicationMenu(null);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
