/**
 * Voice / TTS configuration types and persistence.
 *
 * Two engines are supported:
 *   • web-speech: Browser SpeechSynthesis (always available, zero install).
 *   • kokoro:     Kokoro-82M neural TTS (pre-bundled with the extension —
 *                 no runtime download, no activation required).
 */

import { getVsCodeApi } from '../vscode';

export type VoiceEngineId = 'web-speech' | 'kokoro';

export interface VoiceOption {
    id: string;
    label: string;
    lang?: string;
    description?: string;
    engine: VoiceEngineId;
}

export interface VoiceConfig {
    engine: VoiceEngineId;
    /** Voice id within the active engine; null = engine default. */
    voiceId: string | null;
    rate: number;
}

const STATE_KEY = '__codearchyVoiceConfig';

const DEFAULT_CONFIG: VoiceConfig = {
    engine: 'web-speech',
    voiceId: null,
    rate: 1,
};

let cached: VoiceConfig | null = null;
const listeners = new Set<(cfg: VoiceConfig) => void>();

function readState(): VoiceConfig {
    try {
        const api = getVsCodeApi();
        const state = api.getState() as Record<string, unknown> | undefined;
        const stored = state?.[STATE_KEY] as Partial<VoiceConfig> | undefined;
        if (stored && typeof stored === 'object') {
            return { ...DEFAULT_CONFIG, ...stored };
        }
    } catch {
        /* ignore — fall through to default */
    }
    try {
        const injected = (window as Window & { __CODEARCHY_VOICE_CONFIG?: Partial<VoiceConfig> }).__CODEARCHY_VOICE_CONFIG;
        if (injected && typeof injected === 'object') {
            return { ...DEFAULT_CONFIG, ...injected };
        }
    } catch {
        /* ignore */
    }
    return { ...DEFAULT_CONFIG };
}

function writeState(cfg: VoiceConfig): void {
    try {
        const api = getVsCodeApi();
        const state = (api.getState() as Record<string, unknown> | undefined) ?? {};
        api.setState({ ...state, [STATE_KEY]: cfg });
    } catch {
        /* persistence is best-effort */
    }
}

export function getVoiceConfig(): VoiceConfig {
    if (!cached) {
        cached = readState();
    }
    return cached;
}

export function setVoiceConfig(patch: Partial<VoiceConfig>): VoiceConfig {
    const next = { ...getVoiceConfig(), ...patch };
    cached = next;
    writeState(next);
    listeners.forEach((l) => {
        try { l(next); } catch { /* swallow listener errors */ }
    });
    return next;
}

export function subscribeVoiceConfig(listener: (cfg: VoiceConfig) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
