const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('va', {
  speech: text => ipcRenderer.invoke('va:speech', text),
  initialView: () => ipcRenderer.invoke('va:initial-view'),
  initialModel: () => ipcRenderer.invoke('va:initial-model'),
  report: state => ipcRenderer.send('va:ready', state),
  openSettings: () => ipcRenderer.send('va:open-settings'),
  openChat: () => ipcRenderer.send('va:open-chat'),
  localChat: (operation, value) => ipcRenderer.invoke('va:local-chat', operation, value),
  onChatRefresh: callback => ipcRenderer.on('va:chat-refresh', () => callback()),
  doubaoAudio: (id, pcm) => ipcRenderer.send('va:doubao-audio', id, pcm),
  onDoubaoState: callback => ipcRenderer.on('va:doubao-state', (_event, state) => callback(state)),
  onDoubaoOutput: callback => ipcRenderer.on('va:doubao-output', (_event, output) => callback(output)),
  onDoubaoCaptions: callback => ipcRenderer.on('va:doubao-captions', (_event, state) => callback(state)),
  adjustScale: amount => ipcRenderer.send('va:adjust-scale', amount),
  previewScale: value => ipcRenderer.send('va:preview-scale', value),
  pet: () => ipcRenderer.send('va:pet'),
  bubble: (text, page) => ipcRenderer.send('va:bubble', text, page),
  bubblePainted: revision => ipcRenderer.send('va:bubble-painted', revision),
  onBubble: callback => ipcRenderer.on('va:bubble-content', (_event, data) => callback(data)),
  settings: change => ipcRenderer.invoke('va:settings', change),
  initialSettingsSection: () => ipcRenderer.invoke('va:settings-section'),
  onSettingsSection: callback => ipcRenderer.on('va:settings-section', (_event, section) => callback(section)),
  chooseModel: checkOnly => ipcRenderer.invoke('va:choose-model', checkOnly),
  modelLibrary: (operation, value) => ipcRenderer.invoke('va:model-library', operation, value),
  performance: (operation, value) => ipcRenderer.invoke('va:performance', operation, value),
  openCharacter: () => ipcRenderer.invoke('va:open-character'),
  nameCharacter: name => ipcRenderer.invoke('va:character-name', name),
  openCapturePrivacy: () => ipcRenderer.invoke('va:open-capture-privacy'),
  voiceConfig: change => ipcRenderer.invoke('va:voice-config', change),
  chooseVoiceFile: () => ipcRenderer.invoke('va:voice-file'),
  openVoiceFile: () => ipcRenderer.invoke('va:open-voice-file'),
  previewVoice: () => ipcRenderer.invoke('va:voice-preview'),
  previewReference: () => ipcRenderer.invoke('va:voice-reference-preview'),
  onSettings: callback => ipcRenderer.on('va:settings-changed', (_event, settings) => callback(settings)),
  onSenses: callback => ipcRenderer.on('va:senses-state', (_event, state) => callback(state)),
  onCommand(callback) {
    ipcRenderer.on('va:request', async (_event, id, command) => {
      try {
        const data = await callback(command);
        ipcRenderer.send('va:response', id, { ok: true, data });
      } catch (error) {
        ipcRenderer.send('va:response', id, { ok: false, message: error.message });
      }
    });
  },
});
