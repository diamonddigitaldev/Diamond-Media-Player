const { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store').default;
const store = new Store();
const { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, FILE_REGEX } = require('./constants');

let autoUpdater = null;

let mainWindow = null;

function initAutoUpdater() {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('Update check failed: ' + err.message);
    });
  }, 5000);

  autoUpdater.on('update-available', (info) => {
    const currentVersion = app.getVersion();
    const newVersion = info.version;

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: 'A new version of Diamond Media Player is available!',
      detail: `Current version: ${currentVersion}\nNew version: ${newVersion}\n\nWould you like to download and install this update?`,
      buttons: ['Yes, Update Now', 'No, Later', 'View Changelog'],
      defaultId: 0,
      cancelId: 1
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      } else if (result.response === 2) {
        shell.openExternal(`https://github.com/WillTDA/Diamond-Media-Player/releases/tag/${newVersion}`);
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded successfully!',
      detail: `Version ${info.version} is ready to install. The application will restart to complete the update.`,
      buttons: ['Install Now', 'Install on Quit'],
      defaultId: 0,
      cancelId: 1
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.log('Auto-updater error: ' + err.message);
  });
}

function checkForUpdatesManually() {
  autoUpdater.checkForUpdates().then(result => {
    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'No Updates',
        message: 'You\'re up to date!',
        detail: `Diamond Media Player ${app.getVersion()} is the latest version.`,
        buttons: ['OK', 'View Changelog']
      }).then(result => {
        if (result.response === 1) {
          shell.openExternal(`https://github.com/WillTDA/Diamond-Media-Player/releases/tag/${app.getVersion()}`);
        }
      });
    }
  }).catch(err => {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Update Check Failed',
      message: 'Could not check for updates.',
      detail: err.message,
      buttons: ['OK']
    });
  });
}

function createWindow() {
  let pendingFileToOpen = null;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 775,
    minWidth: 1080,
    minHeight: 775,
    fullscreenable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'assets', 'diamondmediaplayer.ico')
  });

  let gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }

      // Extract and handle the file path if provided in command line arguments
      const filePath = commandLine.find(arg => FILE_REGEX.test(arg));
      if (filePath) {
        handleFileOpen(filePath);
      }
    });
  }

  function handleFileOpen(filePath) {
    if (mainWindow && mainWindow.webContents && mainWindow.webContents.isLoadingMainFrame() === false) {
      mainWindow.webContents.send('selected-file', filePath);
    } else {
      pendingFileToOpen = filePath;
    }
  }

  function handleOpenDialog() {
    let lastDir = store.get('lastOpenedDirectory');

    // Validate directory
    if (!lastDir || !fs.existsSync(lastDir)) {
      lastDir = app.getPath('music');
    }

    dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'Video', extensions: VIDEO_EXTENSIONS }
      ],
      defaultPath: lastDir,
    }).then(result => {
      console.log(result);
      if (!result.canceled) {
        store.set('lastOpenedDirectory', path.dirname(result.filePaths[0]));
        handleFileOpen(result.filePaths[0]);
      }
    }).catch(err => {
      console.log(err);
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools();

  // Send saved preferences and any pending file to renderer process
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('load-preferences', store.store);
    if (pendingFileToOpen) {
      mainWindow.webContents.send('selected-file', pendingFileToOpen);
      pendingFileToOpen = null;
    }
  });

  // Handle the 'open-file' event
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    handleFileOpen(filePath);
  });

  // Handle command-line arguments for other platforms
  if (process.argv.length >= 2) {
    const filePath = process.argv.find(arg => FILE_REGEX.test(arg));
    if (filePath) {
      handleFileOpen(filePath);
    }
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  const menuTemplate = [
    {
      label: 'Menu',
      submenu: [
        {
          label: 'Open File',
          accelerator: process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O',
          click: handleOpenDialog
        },
        {
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: () => {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
            if (mainWindow && !mainWindow.isDestroyed()) {
              const showMenu = mainWindow.isFullScreen();
              mainWindow.setMenuBarVisibility(!showMenu);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Check for Updates',
          click: checkForUpdatesManually
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          role: 'quit'
        }
      ]
    },
    {
      label: 'Preferences',
      accelerator: 'P',
      click: () => {
        createPreferencesWindow();
      }
    },
    {
      label: 'Credits',
      accelerator: 'C',
      click: () => {
        createCreditsWindow();
      }
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  function createPreferencesWindow() {
    const preferencesWindow = new BrowserWindow({
      width: 400,
      height: 300,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      icon: path.join(__dirname, 'assets', 'diamondmediaplayer.ico')
    });

    preferencesWindow.setMenu(null);
    preferencesWindow.loadFile(path.join(__dirname, 'preferences.html'));

    // Ensure it cannot be minimized (also disable minimize/maximize buttons)
    preferencesWindow.on('minimize', (e) => {
      e.preventDefault();
      preferencesWindow.show();
      preferencesWindow.focus();
    });
  }

  function createCreditsWindow() {
    const creditsWindow = new BrowserWindow({
      width: 750,
      height: 450,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      icon: path.join(__dirname, 'assets', 'diamondmediaplayer.ico')
    });

    // Ensure it cannot be minimized (also disable minimize/maximize buttons)
    creditsWindow.on('minimize', (e) => {
      e.preventDefault();
      creditsWindow.show();
      creditsWindow.focus();
    });

    creditsWindow.setMenu(null);
    creditsWindow.loadFile(path.join(__dirname, 'credits.html'));
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  ipcMain.on('open-file-dialog', handleOpenDialog);

  ipcMain.on('save-preferences', (event, preferences, reload = true) => {
    if (preferences.visualiserFftSize) {
      store.set('visualiserFftSize', preferences.visualiserFftSize);
    }
    if (preferences.volume) {
      store.set('volume', preferences.volume);
    }
    if (preferences.eqStaysPaused !== undefined) {
      store.set('eqStaysPaused', preferences.eqStaysPaused);
    }
    if (preferences.tempo !== undefined) {
      store.set('tempo', preferences.tempo);
    }
    if (preferences.pitch !== undefined) {
      store.set('pitch', preferences.pitch);
    }
    if (preferences.linked !== undefined) {
      store.set('linked', preferences.linked);
    }
    if (preferences.loop !== undefined) {
      store.set('loop', preferences.loop);
    }
    if (reload) mainWindow.webContents.send('load-preferences', store.store);
  });

  ipcMain.on('request-preferences', (event) => {
    event.reply('current-preferences', store.store);
  });

  initAutoUpdater();
}

app.whenReady().then(createWindow);