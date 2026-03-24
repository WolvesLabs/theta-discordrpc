const { Plugin, PluginSettingTab, Setting, Menu, View, Notice } = require('obsidian');
const { Client } = require('discord-rpc');

const TEXT_VARIABLES = [
    '{filename} - file name without extension',
    '{file} - file name with extension',
    '{fileExt} - file extension',
    '{vault} - vault name',
    '{currentDir} - file\'s parent folder',
    '{fullPath} - full file path (with extension)',
    '{fullPathName} - full file path (without extension)',
    '{fileSize} - file size',
    '{fileFSize} - formatted file size (Example: 12 Kb)',
    '{tversion} - Theta version'
];

const IMAGES_KEYS = [
    'logo - Obsidian logo'
];

const DEFAULT_VIEW_RULES = [
    { enabled: true, view: 'graph', details: 'Viewing graph', state: 'Vault: {vault}' },
    { enabled: true, view: 'search', details: 'Searching', state: 'Vault: {vault}' },
    { enabled: true, view: 'canvas', details: 'Editing canvas', state: 'Vault: {vault}' },
    { enabled: true, view: 'empty', details: 'Outside the document', state: 'Vault: {vault}' }
];

const DEFAULT_SETTINGS = {
	clientId: '1484246229239205918',
    updateDelay: 20000,
    maxReconnectAttempts: 50,
    reconnectDelay: 20000,
    connectionAtStartup: true,
    global: {
        details: { enabled: true, custom: 'Edit: {filename}', default: 'Editing document' },
        state: { enabled: true, custom: 'Vault: {vault}', default: '{vault}' }
    },
    viewRules: DEFAULT_VIEW_RULES,
    images: { 
        largeKey: 'logo',
        largeText: 'Obsidian',
        smallKey: '',
        smallText: ''
    },
    debugLogs: false
};

class ThetaPlugin extends Plugin {
    settings;
    
    async onload() {
        await this.loadSettings();
        await this.normalizeSettings();

        this.rpc = null;
        this.start = null;
        this.updateInterval = null;
        this.connectInterval = null;
        this.lastActivity = null;

        this.connectAttempts = 0;

        this.addRibbonIcon('pyramid', 'Theta', async (evt) => this.showDropdown(evt));
        this.addSettingTab(new ThetaSettingTab(this.app, this));

        if (this.settings.connectionAtStartup)
            await this.initRPC();
    }

    async onunload() {
        console.log('[Theta] Unloading plugin');
        if (this.connectInterval)
            clearInterval(this.connectInterval);
        await this.closeRPC();
    }

    async showDropdown(evt) {
        const menu = new Menu(this.app);

        const connected = await this.connected();

        menu.addItem((item) => {
            item
                .setTitle(connected 
                    ? 'Connected'
                    : this.connectInterval !== null
                        ? `Connecting ${this.connectAttempts}/${this.settings.maxReconnectAttempts}...`
                        : 'Not connected')
                .setIcon(connected ? 'wifi' : 'wifi-off')
                .setDisabled(true)
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item
                .setTitle(connected ? 'Reconnect' : 'Connect')
                .setDisabled(this.connectInterval !== null)
                .setIcon('refresh-cw')
                .onClick(async () => this.initRPC())
        });

        menu.addItem((item) => {
            item
                .setTitle('Disconnect')
                .setIcon('refresh-cw-off')
                .setDisabled(!(connected || this.connectInterval !== null))
                .onClick(async () => {
                    if (connected || this.connectInterval === null) {
                        await this.closeRPC();
                    }
                    else {
                        await this.closeRPC();
                        await this.clearIntervals();
                    }
                })
        });

        menu.addSeparator();

        menu.addItem((item) => {
            item
                .setTitle('Settings')
                .setIcon('bolt')
                .onClick(async () => {
                    // https://github.com/Mara-Li/obsidian-open-settings/blob/56898e63010ba441d7716f4896e543caaf53785a/src/main.ts#L88
                    this.app.setting.open();
                    this.app.setting.openTabById(this.manifest.id);
                })
        });

        menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
    }

    async closeRPC() {
        try {
            if (this.rpc !== null) {
                this.rpc.clearActivity();
                this.rpc.destroy();
                this.rpc = null;
            }
            if (this.settings.debugLogs)
                console.debug('[Theta] RPC closed');
            await this.clearUpdateInterval();
        } catch(e) {
            this.rpc = null;
            return;
        }
    }

    async clearUpdateInterval() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
            if (this.settings.debugLogs)
                console.debug('[Theta] Update interval stopped');
        }
    }

    async clearConnectInterval() {
        if (this.connectInterval) {
            clearInterval(this.connectInterval);
            this.connectInterval = null;
            if (this.settings.debugLogs)
                console.debug('[Theta] Connect interval stopped');
        }
        this.connectAttempts = 0;
    }

    async clearIntervals() {
        await this.clearUpdateInterval();
        await this.clearConnectInterval();
        if (this.settings.debugLogs)
            console.debug('[Theta] Intervals stopped early');
    }

    async initRPC() {
        await this.closeRPC();

        this.connectAttempts += 1;
        if (this.settings.debugLogs)
            console.debug(`[Theta] Connection attempt: ${this.connectAttempts}/${this.settings.maxReconnectAttempts} (delay: ${this.settings.reconnectDelay})`);
        
        this.rpc = new Client({ transport: 'ipc' });

        this.rpc.on('ready', () => {
            console.log('[Theta] Connected to Discord on', this.settings.clientId);
        });

        this.rpc.on('disconnected', async () => {
            console.log('[Theta] Disconnected from Discord');
            new Notice('Theta: Disconnected');
            await this.clearIntervals();
        });

        this.rpc.login({ clientId: this.settings.clientId })
            .then(
                async () => {
                    console.log(`[Theta] Login completed after ${this.connectAttempts} attempt(-s)`);
                    new Notice('Theta: Connected');
                    this.start = Date.now();
                    this.connectAttempts = 0;
                    this.updateRPC();
                    this.updateInterval = window.setInterval(async () => await this.updateRPC(), this.settings.updateDelay || DEFAULT_SETTINGS.updateDelay);
                    await this.clearConnectInterval();
                },
                async () => {
                    if (this.connectAttempts >= this.settings.maxReconnectAttempts) {
                        new Notice(`Theta: Failed to connect after ${this.connectAttempts}/${this.settings.maxReconnectAttempts} attempts`);
                        if (this.settings.debugLogs)
                            console.debug(`[Theta] Failed to connect after ${this.connectAttempts}/${this.settings.maxReconnectAttempts} attempts`);
                        await this.clearIntervals();
                        await this.closeRPC();
                        return;
                    }
                    else {
                        if (this.settings.debugLogs)
                            console.debug('[Theta] Login failed');
                    }
                    if (!this.connectInterval) {
                        if (this.settings.debugLogs)
                            console.debug('[Theta] Reconnection interval begins');
                        this.connectInterval = window.setInterval(async () => this.initRPC(), this.settings.reconnectDelay || DEFAULT_SETTINGS.reconnectDelay);
                    }
                });
    }

    async updateRPC() {
        if (!this.rpc) {
            console.warn('[Theta] RPC client not initialized');
            await this.clearUpdateInterval();
            return;
        }

        if (!this.rpc.transport) {
            console.warn('[Theta] RPC transport not ready');
            return;
        }

        try {
            const view = this.app.workspace.getActiveViewOfType(View);
            if (!view) {
                if (this.settings.debugLogs)
                    console.debug('[Theta] No active view');
            }
            const viewType = view ? view.getViewType() : null;
            const file = this.app.workspace.getActiveFile();
            const vault = this.app.vault.getName();

            if (this.settings.debugLogs)
                console.debug(`[Theta] Current view type: ${viewType}, file: ${file?.name}`);
            
            const details = view
                ? await this.getTextForView(viewType, 'details', file, vault)
                : await this.replaceVariables(this.settings.global.details.enabled
                    ? this.settings.global.details.custom
                    : this.settings.global.details.default
                    || DEFAULT_SETTINGS.global.details.custom,
                    file, vault
                );
            const state = view
                ? await this.getTextForView(viewType, 'state', file, vault)
                : await this.replaceVariables(this.settings.global.state.enabled
                    ? this.settings.global.state.custom
                    : this.settings.global.state.default
                    || DEFAULT_SETTINGS.global.state.default,
                    file, vault
                );

            const activity = {
                details: details,
                state: state,
                largeImageKey: this.settings.images?.largeKey || DEFAULT_SETTINGS.images.largeKey,
                largeImageText: this.settings.images?.largeText || DEFAULT_SETTINGS.images.largeText,
                startTimestamp: this.start,
                instance: false
            };

            if (this.settings.images?.smallKey) {
                activity.smallImageKey = this.settings.images.smallKey;
                activity.smallImageText = this.settings.images.smallText;
            }

            if (await this.compareActivity(activity)) {
                await this.rpc.setActivity(activity);

                this.lastActivity = activity;

                if (this.settings.debugLogs)
                    console.debug('[Theta] Activity set successfully');
            }
            else {
                if (this.settings.debugLogs)
                    console.debug('[Theta] Skip updating (same values)');
            }
        } catch(e) {
            console.error('[Theta] Error setting activity:', e);
        }
    }

    async getVariables(file, vault) {
        return {
            tversion: this.manifest.version,
            filename: file ? file.basename : 'Unknown',
            file: file ? file.name : 'Unknown',
            vault: vault,
            fileExt: file ? file.extension : '',
            currentDir: file ? file.parent?.name : '',
            fullPath: file ? file.path : 'Unknown',
            fullPathName: file ? file.extension ? `${file.path}`.replace('.'+file.extension, '') : file.path : 'Unknown',
            fileSize: file ? Math.round(file.stat.size / 1024) : 0,
            fileFSize: file ? (Math.round(file.stat.size / 1024)) >= 1024
                ? `${(Math.round(file.stat.size / 1024) / 1024).toFixed(1)} Mb`
                : `${Math.round(file.stat.size / 1024)} Kb` : ''
        }
    }

    async replaceVariables(text, file, vault) {
        if (!text || text === '')
            return 'Unknown';

        const vars = await this.getVariables(file, vault);
        let res = text;

        for (const [key, value] of Object.entries(vars))
            res = res.replace(new RegExp(`{${key}}`, 'g'), value);
        return res;
    }

    async getTextForView(view, target, file, vault) {
        const rule = this.settings.viewRules.find(r => r.view == view && r.enabled);

        if (rule) {
            const text = target === 'details' ? rule.details : rule.state;
            return await this.replaceVariables(text, file, vault);
        }

        const global = this.settings.global[target];
        return await this.replaceVariables((
            global.enabled
                ? global.custom
                : global.default && global.default !== ''
                    ? global.default
                    : global.custom
            ) || 'Editing document',
            file, vault
        );
    }

    async compareActivity(newActivity) {
        if (!this.lastActivity)
            return true;
        return this.lastActivity.details !== newActivity.details ||
            this.lastActivity.state !== newActivity.state ||
            this.lastActivity.startTimestamp !== newActivity.startTimestamp ||
            this.lastActivity.largeImageKey !== newActivity.largeImageKey ||
            this.lastActivity.largeImageText !== newActivity.largeImageText ||
            (this.lastActivity.smallImageKey || '') !== (newActivity.smallImageKey || '') ||
            (this.lastActivity.smallImageText || '') !== (newActivity.smallImageText || '')
    }

    async addRule() {
        this.settings.viewRules.push({
            enabled: false,
            view: '',
            details: '',
            state: ''
        });
        await this.saveSettings();
    }

    async removeRule(index) {
        this.settings.viewRules.splice(index, 1);
        await this.saveSettings();
    }

    async updateRule(index, field, value) {
        this.settings.viewRules[index][field] = value;
        await this.saveSettings();
    }

    async resetRules() {
        this.settings.viewRules = JSON.parse(JSON.stringify(DEFAULT_VIEW_RULES));
        await this.saveSettings();
    }

    async connected() {
        const rpcT = this.rpc !== null && this.rpc.transport;
        if (!rpcT)
            return false;
        else if (rpcT && this.connectInterval !== null)
            return false;
        else
            return true;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    
    async saveSettings() {
        await this.saveData(this.settings);
    }

    async normalizeSettings() {
        let needsSave = false;

        if (!this.settings.images) {
            this.settings.images = DEFAULT_SETTINGS.images;
            needsSave = true
        }
        
        if (!this.settings.images.largeKey) {
            this.settings.images.largeKey = DEFAULT_SETTINGS.images.largeKey;
            needsSave = true
        }

        if (needsSave)
            await this.saveSettings();
    }
}

class ThetaSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display() {
        const { containerEl } = this;

        containerEl.empty();
        await this.createConnectionSection(containerEl);
        await this.createPerformanceSection(containerEl);
        await this.createDefaultsSection(containerEl);
        await this.createRulesSection(containerEl);
        await this.createImagesSection(containerEl);
        await this.createDebugSection(containerEl);
        await this.createVariablesSection(containerEl);
    }

    async createConnectionSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-connection-section' });
        
        section.createEl('h2', { text: 'Connection' });

        const connected = await this.plugin.connected();

        new Setting(section)
            .setName('Client ID')
            .setDesc('Don\'t touch if you don\'t know what it is.')
            .addText(text => text
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                })
            )
            .addButton(button => button
                .setIcon('refresh-ccw')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.clientId = DEFAULT_SETTINGS.clientId;
                    await this.plugin.saveSettings();
                    await this.display();
                })
                .setTooltip('Reset to default')
            );
        
        new Setting(section)
            .setName(connected 
                    ? 'Connected'
                    : this.plugin.connectInterval !== null
                        ? `Connecting ${this.plugin.connectAttempts}/${this.plugin.settings.maxReconnectAttempts}...`
                        : 'Not connected')
            .addButton(button => button
                .setButtonText(connected ? 'Reconnect' : 'Connect')
                .setDisabled(this.plugin.connectInterval !== null)
                .onClick(async () => {
                    await this.plugin.initRPC();
                    await this.display();
                })
            )
            .addButton(button => button
                .setButtonText('Disconnect')
                .setDisabled(!(connected || this.plugin.connectInterval !== null))
                .onClick(async () => {
                    if (connected || this.plugin.connectInterval === null) {
                        await this.plugin.closeRPC();
                    }
                    else {
                        await this.plugin.closeRPC();
                        await this.plugin.clearIntervals();
                        if (this.plugin.settings.debugLogs)
                            console.debug('[Theta] Intervals stopped early');
                    }
                    await this.display();
                })
            );

        new Setting(section)
            .setName('Connection at startup')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.connectionAtStartup)
                .onChange(async (value) => {
                    this.plugin.settings.connectionAtStartup = value;
                    await this.plugin.saveSettings();
                })
            );
    }

    async createPerformanceSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-performance-section' });

        section.createEl('h2', { text: 'Performance' });

        new Setting(section)
            .setName('Update delay (ms)')
            .addSlider(slider => slider
                .setLimits(10000, 40000, 500)
                .setValue(this.plugin.settings.updateDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.updateDelay = value;
                    await this.plugin.saveSettings();
                })
            )
            .addButton(button => button
                .setIcon('refresh-ccw')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.updateDelay = DEFAULT_SETTINGS.updateDelay;
                    await this.plugin.saveSettings();
                    await this.display();
                })
                .setTooltip('Reset to default')
            );
        
        new Setting(section)
            .setName('Reconnection delay (ms)')
            .addSlider(slider => slider
                .setLimits(10000, 40000, 500)
                .setValue(this.plugin.settings.reconnectDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.reconnectDelay = value;
                    if (this.plugin.connectInterval) {
                        clearInterval(this.plugin.connectInterval);
                        this.plugin.connectInterval = window.setInterval(async () => this.plugin.initRPC(), this.plugin.settings.reconnectDelay || DEFAULT_SETTINGS.reconnectDelay);
                    }
                    await this.plugin.saveSettings();
                })
            )
            .addButton(button => button
                .setIcon('refresh-ccw')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.reconnectDelay = DEFAULT_SETTINGS.reconnectDelay;
                    await this.plugin.saveSettings();
                    await this.display();
                })
                .setTooltip('Reset to default')
            );
        
        new Setting(section)
            .setName('Maximum reconnection attempts')
            .addSlider(slider => slider
                .setLimits(5, 100, 5)
                .setValue(this.plugin.settings.maxReconnectAttempts)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxReconnectAttempts = value;
                    await this.plugin.saveSettings();
                })
            )
            .addButton(button => button
                .setIcon('refresh-ccw')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.maxReconnectAttempts = DEFAULT_SETTINGS.maxReconnectAttempts;
                    await this.plugin.saveSettings();
                    await this.display();
                })
                .setTooltip('Reset to default')
            );
    }

    async createDefaultsSection (containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-defaults-section' });

        section.createEl('h2', { text: 'Text values (view types that have no rules)' });

        this.createDefaultRow(section, 'Details', this.plugin.settings.global.details, async () => {
            await this.plugin.saveSettings();
            await this.plugin.updateRPC();
        });
        this.createDefaultRow(section, 'State', this.plugin.settings.global.state, async () => {
            await this.plugin.saveSettings();
            await this.plugin.updateRPC();
        });
    }
    
    createDefaultRow(container, label, config, onSave) {
        const row = container.createEl('div', { cls: 'theta-drpc-defaults-row' });

        row.createEl('span', { text: label, style: 'font-weight: 600;' });

        const toggleContainer = row.createEl('div');

        new Setting(toggleContainer)
            .addToggle(toggle => toggle
                .setValue(config.enabled)
                .onChange(async (value) => {
                    config.enabled = value;
                    await onSave();
                })
            );
        
        const customInput = row.createEl('input', { cls: 'theta-drpc-input' });

        customInput.type = 'text';
        customInput.placeholder = 'Value if the parameter is enabled';
        customInput.ariaLabel = 'Value if the parameter is enabled';
        customInput.value = config.custom;
        customInput.onchange = async (e) => {
            config.custom = e.taget.value;
            await onSave();
        };

        const defaultInput = row.createEl('input', { cls: 'theta-drpc-inupt' });

        defaultInput.type = 'text';
        defaultInput.placeholder = 'Value if the parameter is disabled';
        defaultInput.ariaLabel = 'Value if the parameter is disabled';
        defaultInput.value = config.default;
        defaultInput.onchange = async (e) => {
            config.default = e.target.value;
            await onSave();
        };
    }

    async createRulesSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-rules-section' });

        const header = section.createEl('div', { cls: 'theta-drpc-rules-section-header' });

        header.createEl('h2', { text: 'Rules' });

        new Setting(header)
            .addButton(btn => btn
                .setIcon('plus')
                .setCta()
                .onClick(async () => {
                    await this.plugin.addRule();
                    await this.display();
                })
                .setTooltip('Add rule')
            )
            .addButton(btn => btn
                .setIcon('refresh-cw')
                .setCta()
                .onClick(async () => {
                    await this.plugin.resetRules();
                    await this.display();
                })
                .setTooltip('Reset all rules to default')
            );
        
        const rulesContainer = section.createEl('div', { cls: 'theta-drpc-rules-section-container' });

        this.plugin.settings.viewRules.forEach((rule, index) => this.createRuleTile(rulesContainer, rule, index));
    }

    createRuleTile(container, rule, index) {
        const tile = container.createEl('div', { cls: 'theta-drpc-rule-tile' });

        const header = tile.createEl('div', { cls: 'theta-drpc-rule-tile-header' });
        const content = tile.createEl('div', { cls: 'theta-drpc-rule-tile-content' });

        const viewInput = header.createEl('input', { cls: 'theta-drpc-input' });

        viewInput.type = 'text';
        viewInput.placeholder = 'View type';
        viewInput.ariaLabel = 'View type';
        viewInput.value = rule.view;
        viewInput.onchange = async (e) => {
            await this.plugin.updateRule(index, 'view', e.target.value);
            await this.plugin.updateRPC();
            await this.display();
        };

        const controls = header.createEl('div', { cls: 'theta-drpc-rule-tile-controls' });

        new Setting(controls)
            .addToggle(toggle => toggle
                .setValue(rule.enabled)
                .onChange(async (value) => {
                    await this.plugin.updateRule(index, 'enabled', value);
                    await this.plugin.updateRPC();
                })
            );
        
        new Setting(controls)
            .addButton(btn => btn
                .setIcon('trash-2')
                .setCta()
                .onClick(async () => {
                    await this.plugin.removeRule(index);
                    await this.display();
                })
            );
        
        const detailsInput = content.createEl('input', { cls: 'theta-drpc-input' });

        detailsInput.type = 'text';
        detailsInput.placeholder = 'Details';
        detailsInput.ariaLabel = 'Details';
        detailsInput.value = rule.details;
        detailsInput.onchange = async (e) => {
            await this.plugin.updateRule(index, 'details', e.target.value);
            await this.plugin.updateRPC();
        };

        const stateInput = content.createEl('input', { cls: 'theta-drpc-input' });

        stateInput.type = 'text';
        stateInput.placeholder = 'State';
        stateInput.ariaLabel = 'State';
        stateInput.value = rule.state;
        stateInput.onchange = async (e) => {
            await this.plugin.updateRule(index, 'state', e.target.value);
            await this.plugin.updateRPC();
        };
    }

    async createImagesSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-images-section' });

        const imgs = this.plugin.settings.images || DEFAULT_SETTINGS.images;

        if (!this.plugin.settings.images)
            this.plugin.settings.images = imgs;

        const rootContainer = section.createEl('div', { cls: 'theta-drpc-images-container' });

        const largeContainer = rootContainer.createEl('div', { cls: 'theta-drpc-large-image' });

        largeContainer.createEl('h2', { text: 'Large image' });
        this.createImageTile(largeContainer, 'large');

        const smallContainer = rootContainer.createEl('div', { cls: 'theta-drpc-small-image' });

        smallContainer.createEl('h2', { text: 'Small image' });
        this.createImageTile(smallContainer, 'small');
    }

    createImageTile(container, imageType) {
        const tile = container.createEl('div', { cls: 'theta-drpc-image-tile' });

        new Setting(tile)
            .setName('Key')
            .addText(text => text
                .setValue(this.plugin.settings.images[imageType+'Key'])
                .onChange(async (value) => {
                    this.plugin.settings.images[imageType+'Key'] = value;
                    await this.plugin.saveSettings();
                })
            );
        
        new Setting(tile)
            .setName('Text')
            .addText(text => text
                .setValue(this.plugin.settings.images[imageType+'Text'])
                .onChange(async (value) => {
                    this.plugin.settings.images[imageType+'Text'] = value;
                    await this.plugin.saveSettings();
                })
            );
    }

    async createVariablesSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-vars-section' });

        section.createEl('h2', { text: 'Text variables (to format text fields)' });
        
        const list = section.createEl('ul', { cls: 'theta-drpc-vars-list' });

        list.createEl('li', { text: '⚠️ Variables are not supported in images texts', cls: 'theta-drpc-vars-list-item' });

        TEXT_VARIABLES.forEach(v => {
            list.createEl('li', { text: v, cls: 'theta-drpc-vars-list-item' });
        });

        section.createEl('h2', { text: 'Images keys' });

        const imgList = section.createEl('ul', { cls: 'theta-drpc-vars-list' });

        IMAGES_KEYS.forEach(i => {
            imgList.createEl('li', { text: i, cls: 'theta-drpc-vars-list-item' });
        });
    }

    async createDebugSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'theta-drpc-debug-section' });

        section.createEl('h2', { text: 'Debug' });

        new Setting(section)
            .setName('Extended logs')
            .setDesc('Needed only for debugging')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugLogs)
                .onChange(async (value) => {
                    this.plugin.settings.debugLogs = value;
                    await this.plugin.saveSettings();
                })
            );
    }
}

module.exports = ThetaPlugin;