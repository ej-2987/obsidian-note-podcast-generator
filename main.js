'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath, Modal } = require('obsidian');

const DEFAULT_SETTINGS = {
    scriptProvider: 'openai',
    openaiApiKey: '',
    anthropicApiKey: '',
    geminiApiKey: '',
    geminiModel: 'gemini-pro',
    ttsVoice: 'nova',
    outputFolder: 'Podcasts',
};

// ─── Utility ────────────────────────────────────────────────────────────────

async function ensureFolder(vault, folderPath) {
    const parts = folderPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await vault.adapter.exists(normalizePath(current)))) {
            await vault.createFolder(normalizePath(current));
        }
    }
}

// ─── Script generation ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional podcast host and scriptwriter.
Your job is to turn a note into a natural, engaging 3-minute English podcast monologue.
Rules:
- Approximately 420–450 words (spoken at a comfortable pace ≈ 3 minutes)
- Start with a short, hooky opening sentence that draws the listener in
- Cover the key ideas from the note in a conversational, flowing tone with smooth transitions
- Use concrete examples or analogies to illustrate abstract points
- End with a clear takeaway or thought-provoking closing line
- Output ONLY the words to be spoken — no stage directions, headers, or markdown`;

function buildUserPrompt(noteName, content) {
    const trimmed = content.length > 6000 ? content.slice(0, 6000) + '\n...[truncated]' : content;
    return `Note title: "${noteName}"\n\nContent:\n${trimmed}`;
}

async function generateScript(settings, noteName, content) {
    const userMsg = buildUserPrompt(noteName, content);

    switch (settings.scriptProvider) {
        case 'openai':
            return callOpenAI(settings.openaiApiKey, userMsg);
        case 'anthropic':
            return callAnthropic(settings.anthropicApiKey, userMsg);
        case 'gemini':
            return callGemini(settings.geminiApiKey, settings.geminiModel || 'gemini-pro', userMsg);
        default:
            throw new Error(`Unknown provider: ${settings.scriptProvider}`);
    }
}

async function callOpenAI(apiKey, userMsg) {
    const res = await requestUrl({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        throw: false,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMsg },
            ],
            max_tokens: 700,
            temperature: 0.75,
        }),
    });
    if (res.status !== 200) {
        const detail = res.json?.error?.message || res.text;
        throw new Error(`OpenAI ${res.status}: ${detail}`);
    }
    return res.json.choices[0].message.content.trim();
}

async function callAnthropic(apiKey, userMsg) {
    const res = await requestUrl({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        throw: false,
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 700,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMsg }],
        }),
    });
    if (res.status !== 200) {
        const detail = res.json?.error?.message || res.text;
        throw new Error(`Anthropic ${res.status}: ${detail}`);
    }
    return res.json.content[0].text.trim();
}

async function callGemini(apiKey, model, userMsg) {
    const res = await requestUrl({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        throw: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n---\n\n' + userMsg }] }],
            generationConfig: { maxOutputTokens: 700, temperature: 0.75 },
        }),
    });
    if (res.status !== 200) {
        const detail = res.json?.error?.message || res.text;
        throw new Error(`Gemini ${res.status}: ${detail}`);
    }
    return res.json.candidates[0].content.parts[0].text.trim();
}

// ─── TTS (OpenAI) ────────────────────────────────────────────────────────────

async function textToSpeech(apiKey, text, voice) {
    const res = await requestUrl({
        url: 'https://api.openai.com/v1/audio/speech',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: voice || 'nova',
            response_format: 'mp3',
        }),
    });
    if (res.status !== 200) throw new Error(`OpenAI TTS error ${res.status}`);
    return res.arrayBuffer;
}

// ─── Script Preview Modal ────────────────────────────────────────────────────

class ScriptPreviewModal extends Modal {
    constructor(app, script, onConfirm) {
        super(app);
        this.script = script;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: '📝 Generated Podcast Script' });

        const wordCount = this.script.trim().split(/\s+/).length;
        const mins = (wordCount / 145).toFixed(1);
        contentEl.createEl('p', {
            text: `~${wordCount} words · ~${mins} min at natural pace`,
            cls: 'setting-item-description',
        });

        const textarea = contentEl.createEl('textarea', {
            cls: 'podcast-script-textarea',
        });
        textarea.value = this.script;
        textarea.style.cssText = 'width:100%;height:220px;resize:vertical;font-size:14px;padding:8px;border-radius:6px;';

        const btnRow = contentEl.createDiv({ cls: 'podcast-btn-row' });
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end;';

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnRow.createEl('button', { text: '🎙️ Generate Audio', cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm(textarea.value);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

class NotePodcastGenerator extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('mic', 'Generate Podcast from Note', () => this.run());

        this.addCommand({
            id: 'generate-podcast',
            name: 'Generate Podcast from Current Note',
            callback: () => this.run(),
        });

        this.addSettingTab(new PodcastSettingTab(this.app, this));
    }

    async run() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('⚠️ No active note. Please open a note first.');
            return;
        }

        // Validate keys
        if (!this.settings.openaiApiKey) {
            new Notice('⚠️ OpenAI API key is required for TTS. Set it in plugin settings.');
            return;
        }
        if (this.settings.scriptProvider === 'anthropic' && !this.settings.anthropicApiKey) {
            new Notice('⚠️ Anthropic API key is missing. Set it in plugin settings.');
            return;
        }
        if (this.settings.scriptProvider === 'gemini' && !this.settings.geminiApiKey) {
            new Notice('⚠️ Gemini API key is missing. Set it in plugin settings.');
            return;
        }

        const content = await this.app.vault.read(file);
        if (!content.trim()) {
            new Notice('⚠️ Note is empty.');
            return;
        }

        const notice = new Notice('✍️ Generating podcast script…', 0);

        let script;
        try {
            script = await generateScript(this.settings, file.basename, content);
        } catch (err) {
            notice.hide();
            new Notice(`❌ Script generation failed: ${err.message}`);
            console.error('[PodcastGen] script error', err);
            return;
        }

        notice.hide();

        // Preview modal — user can edit script before TTS
        new ScriptPreviewModal(this.app, script, async (finalScript) => {
            await this.convertAndSave(file.basename, finalScript);
        }).open();
    }

    async convertAndSave(noteName, script) {
        const notice = new Notice('🎙️ Converting to audio…', 0);
        try {
            const audioBuffer = await textToSpeech(
                this.settings.openaiApiKey,
                script,
                this.settings.ttsVoice
            );

            const folder = normalizePath(this.settings.outputFolder || 'Podcasts');
            const scriptsFolder = normalizePath(`${folder}/scripts`);
            await ensureFolder(this.app.vault, folder);
            await ensureFolder(this.app.vault, scriptsFolder);

            const ts = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);
            const safeName = noteName.replace(/[\\/:*?"<>|]/g, '_');

            // Save MP3
            const audioPath = normalizePath(`${folder}/${safeName}_podcast_${ts}.mp3`);
            await this.app.vault.adapter.writeBinary(audioPath, audioBuffer);

            // Save script as markdown
            const scriptPath = normalizePath(`${scriptsFolder}/${safeName}_script_${ts}.md`);
            const wordCount = script.trim().split(/\s+/).length;
            const mins = (wordCount / 145).toFixed(1);
            const scriptContent = `---\nsource: "[[${noteName}]]"\ncreated: ${ts.replace('-', 'T').slice(0, 16)}\nwords: ${wordCount}\nduration: ~${mins} min\naudio: "[[${safeName}_podcast_${ts}.mp3]]"\n---\n\n${script}\n`;
            await this.app.vault.adapter.write(scriptPath, scriptContent);

            notice.hide();
            new Notice(`✅ Podcast saved!\n🎵 ${audioPath}\n📄 ${scriptPath}`, 8000);
        } catch (err) {
            notice.hide();
            new Notice(`❌ Audio generation failed: ${err.message}`);
            console.error('[PodcastGen] TTS error', err);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class PodcastSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Note Podcast Generator' });

        // Script provider
        new Setting(containerEl)
            .setName('Script AI provider')
            .setDesc('AI used to write the 3-minute podcast script from your note.')
            .addDropdown(dd => dd
                .addOption('openai', 'OpenAI GPT-4o-mini (cheapest if using OpenAI TTS anyway)')
                .addOption('anthropic', 'Claude Haiku (Anthropic)')
                .addOption('gemini', 'Gemini 2.0 Flash (Google — lowest cost/token)')
                .setValue(this.plugin.settings.scriptProvider)
                .onChange(async v => {
                    this.plugin.settings.scriptProvider = v;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // OpenAI key (always shown — needed for TTS)
        new Setting(containerEl)
            .setName('OpenAI API key')
            .setDesc('Required for TTS audio generation (and script if provider = OpenAI).')
            .addText(t => t
                .setPlaceholder('sk-…')
                .setValue(this.plugin.settings.openaiApiKey)
                .onChange(async v => {
                    this.plugin.settings.openaiApiKey = v.trim();
                    await this.plugin.saveSettings();
                }));

        // Anthropic key (conditional)
        if (this.plugin.settings.scriptProvider === 'anthropic') {
            new Setting(containerEl)
                .setName('Anthropic API key')
                .setDesc('Required for Claude Haiku script generation.')
                .addText(t => t
                    .setPlaceholder('sk-ant-…')
                    .setValue(this.plugin.settings.anthropicApiKey)
                    .onChange(async v => {
                        this.plugin.settings.anthropicApiKey = v.trim();
                        await this.plugin.saveSettings();
                    }));
        }

        // Gemini key (conditional)
        if (this.plugin.settings.scriptProvider === 'gemini') {
            new Setting(containerEl)
                .setName('Google Gemini API key')
                .setDesc('Google AI Studio API key (aistudio.google.com → Get API key).')
                .addText(t => t
                    .setPlaceholder('AIza…')
                    .setValue(this.plugin.settings.geminiApiKey)
                    .onChange(async v => {
                        this.plugin.settings.geminiApiKey = v.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Gemini model name')
                .setDesc('Model ID to use. Check available models at aistudio.google.com. Common: gemini-pro, gemini-1.5-flash, gemini-1.5-pro, gemini-2.0-flash')
                .addText(t => t
                    .setPlaceholder('gemini-pro')
                    .setValue(this.plugin.settings.geminiModel || 'gemini-pro')
                    .onChange(async v => {
                        this.plugin.settings.geminiModel = v.trim() || 'gemini-pro';
                        await this.plugin.saveSettings();
                    }));
        }

        // TTS voice
        new Setting(containerEl)
            .setName('TTS voice')
            .setDesc('OpenAI TTS-1 voice for the audio output.')
            .addDropdown(dd => dd
                .addOption('alloy', 'Alloy — neutral')
                .addOption('echo', 'Echo — male')
                .addOption('fable', 'Fable — British male')
                .addOption('onyx', 'Onyx — deep male')
                .addOption('nova', 'Nova — female (default)')
                .addOption('shimmer', 'Shimmer — soft female')
                .setValue(this.plugin.settings.ttsVoice)
                .onChange(async v => {
                    this.plugin.settings.ttsVoice = v;
                    await this.plugin.saveSettings();
                }));

        // Output folder
        new Setting(containerEl)
            .setName('Output folder')
            .setDesc('Vault path where .mp3 files are saved. A "scripts" subfolder is created automatically alongside it.')
            .addText(t => t
                .setPlaceholder('Podcasts')
                .setValue(this.plugin.settings.outputFolder)
                .onChange(async v => {
                    this.plugin.settings.outputFolder = v.trim() || 'Podcasts';
                    await this.plugin.saveSettings();
                }));

        // How-to
        containerEl.createEl('h3', { text: 'How to use' });
        const ul = containerEl.createEl('ul');
        [
            'Open any note in your vault.',
            'Click the 🎙 microphone icon in the ribbon, or run "Generate Podcast from Current Note" from the command palette.',
            'Review and optionally edit the AI-generated script in the preview.',
            'Click "Generate Audio" — the MP3 is saved to your output folder.',
        ].forEach(step => ul.createEl('li', { text: step }));
    }
}

module.exports = NotePodcastGenerator;
