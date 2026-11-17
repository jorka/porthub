import * as vscode from 'vscode';
import type { PortEntry } from '@porthub/core';
import { PortStore, remoteHostLabel } from './store';
import { PortsViewProvider, openInBrowser } from './PortsViewProvider';
import { entryLabel, killEntry } from './kill';
import { editPortLabel, getPortLabels } from './labels';
import { registerTerminalWatch, type DetectedConflict } from './terminalWatch';
import { registerTasks } from './tasks';
import { stopWorkspaceServers, stopWorkspaceServersOnClose } from './workspaceServers';
import { PortWatcher, toggleWatchedPort, type WatchedPortChange } from './watch';
import { switchPort, type SwitchPortOptions } from './switchPort';
import { registerSharedPortWarning } from './sharedWarning';

let activeStore: PortStore | undefined;

/** Public API returned from activate(): `vscode.extensions.getExtension('<publisher>.porthub').exports`. */
export interface PortHubApi {
  /** Fires when a terminal command fails (or moves) because its port is taken. */
  onDidDetectPortConflict: vscode.Event<DetectedConflict>;
  /** The latest list of listening ports (after the last refresh). */
  getPorts(): PortEntry[];
  /** The ports the panel shows, after "Hide apps & system" and "This workspace". */
  getVisiblePorts(): PortEntry[];
  /** Re-scans the ports now. */
  refresh(): Promise<void>;
  /** Fires when a watched port (porthub.watchPorts) starts or stops listening. */
  onDidChangeWatchedPort: vscode.Event<WatchedPortChange>;
}

export function activate(ctx: vscode.ExtensionContext): PortHubApi {
  const store = new PortStore();
  activeStore = store;
  ctx.subscriptions.push(store);

  const provider = new PortsViewProvider(ctx.extensionUri, store);
  const watcher = new PortWatcher(store, { show: (port) => provider.showPort(port), open: (port, scheme) => openInBrowser(port, scheme) });
  provider.watcher = watcher;
  ctx.subscriptions.push(watcher);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PortsViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Status bar: "$(plug) 7 ports"
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'porthub.show';
  ctx.subscriptions.push(status);
  const updateStatus = () => {
    if (!vscode.workspace.getConfiguration('porthub').get<boolean>('showStatusBar', true)) {
      status.hide();
      return;
    }
    const n = store.visibleEntries.length;
    const down = watcher.down();
    if (down.length) {
      status.text = `$(warning) ${down.length === 1 ? `${down[0]} down` : `${down.length} watched ports down`}`;
      status.tooltip = `Watched port${down.length === 1 ? '' : 's'} not listening: ${down.join(', ')}. ${n} listening port${n === 1 ? '' : 's'} in total. Click to show.`;
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      status.text = `$(plug) ${n}`;
      const where = remoteHostLabel();
      status.tooltip = `${n} listening port${n === 1 ? '' : 's'}${where ? ` in ${where}` : ''}. Click to show.`;
      status.backgroundColor = undefined;
    }
    status.show();
  };
  ctx.subscriptions.push(store.onDidChange(updateStatus));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('porthub.refresh', () => store.refresh()),
    vscode.commands.registerCommand('porthub.show', () => vscode.commands.executeCommand(`${PortsViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('porthub.killPort', (port?: number) => pickAndKill(store, port)),
    vscode.commands.registerCommand('porthub.openInBrowser', (port?: number) => (typeof port === 'number' ? openInBrowser(port, store.snapshot.entries.find((e) => e.port === port)?.http ?? 'http') : undefined)),
    vscode.commands.registerCommand('porthub.switchPort', (port?: number, newPort?: number, opts?: SwitchPortOptions) => switchPort(store, port, newPort, opts)),
    vscode.commands.registerCommand('porthub.toggleWatch', (port?: number) => (typeof port === 'number' ? toggleWatchedPort(port) : undefined)),
    vscode.commands.registerCommand('porthub.stopWorkspaceServers', () => stopWorkspaceServers(store)),
    vscode.commands.registerCommand('porthub.editLabel', (port?: number) => editPortLabel(port)),
    vscode.commands.registerCommand('porthub.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`),
    ),
    vscode.commands.registerCommand('porthub.toggleHideApps', () => toggleSetting('hideAppsAndSystem', true)),
    vscode.commands.registerCommand('porthub.toggleWorkspaceOnly', () => toggleSetting('workspaceOnly', false)),
  );

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('porthub')) return;
      if (e.affectsConfiguration('porthub.watchPorts')) watcher.resetBaseline();
      store.restartTimer();
      updateStatus();
      void store.refresh();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void store.refresh();
    }),
  );

  const onDidDetectPortConflict = registerTerminalWatch(ctx, store, (port) => provider.showPort(port));
  registerTasks(ctx, store);
  registerSharedPortWarning(ctx, store, {
    show: (port) => provider.showPort(port),
    move: (port, pid) => switchPort(store, port, undefined, { pid }),
  });
  store.restartTimer();
  void store.refresh();
  return { onDidDetectPortConflict, getPorts: () => store.snapshot.entries,
    getVisiblePorts: () => store.visibleEntries, refresh: () => store.refresh(), onDidChangeWatchedPort: watcher.onDidChange };
}

function toggleSetting(key: string, defaultValue: boolean): Thenable<void> {
  const cfg = vscode.workspace.getConfiguration('porthub');
  return cfg.update(key, !cfg.get<boolean>(key, defaultValue), vscode.ConfigurationTarget.Global);
}

async function pickAndKill(store: PortStore, port?: number): Promise<void> {
  await store.refresh();
  // An explicit port number means that port, even if the panel's switches hide it.
  const entries = typeof port === 'number' ? store.snapshot.entries : store.visibleEntries;

  if (typeof port === 'number') {
    const matches = entries.filter((e) => e.port === port);
    if (matches.length === 0) {
      void vscode.window.showInformationMessage(`Nothing is listening on port ${port}.`);
      return;
    }
    for (const e of matches) await killEntry(store, e);
    return;
  }

  type Item = vscode.QuickPickItem & { entry: PortEntry };
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = 'Pick a port to kill, or type a port number';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const labels = getPortLabels();
  qp.items = entries.map((e) => ({
    label: labels[e.port] ? `:${e.port}  ${labels[e.port]}` : `:${e.port}`,
    description: e.container ? `${entryLabel(e).replace(/ on port \d+$/, '')}  ·  ${e.container.image}` : `${e.processName}  ·  pid ${e.pid || '?'}`,
    detail: e.cwd ?? e.command,
    entry: e,
  }));

  const picked = await new Promise<PortEntry[] | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel) return resolve([sel.entry]);
      const n = Number(qp.value.trim().replace(/^:/, ''));
      resolve(Number.isInteger(n) ? entries.filter((e) => e.port === n) : undefined);
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!picked) return;
  if (picked.length === 0) {
    void vscode.window.showInformationMessage(`Nothing is listening on port ${qp.value.trim()}.`);
    return;
  }
  for (const e of picked) await killEntry(store, e);
}

/** VS Code waits (briefly) for the returned promise when the window closes. */
export function deactivate(): Promise<void> | undefined {
  return activeStore ? stopWorkspaceServersOnClose(activeStore) : undefined;
}
