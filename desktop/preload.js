// 桌面壳能力注入：只暴露本机 relay 探测一个能力（contextIsolation 隔离下最小暴露面）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccDeck", {
  probeLocal: () => ipcRenderer.invoke("cc-deck:probe-local"),
  setNativeTheme: (dark) => ipcRenderer.send("cc-deck:set-native-theme", !!dark),
});
