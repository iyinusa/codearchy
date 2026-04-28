/**
 * Curated catalog of Kokoro-82M voices.
 *
 * The full Kokoro-82M model ships with 50+ voices keyed by short codes
 * (e.g. `af_bella`, `am_michael`). The naming convention is:
 *   • First letter:  a = American, b = British
 *   • Second letter: f = Female, m = Male
 *   • Suffix:        Voice persona name
 *
 * We surface a curated subset that covers a good range of accents and
 * personas without overwhelming the picker. Power users can switch to the
 * full list later via the `kokoro-js` `list_voices()` API.
 */

import type { VoiceOption } from './voiceConfig';

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** q8 keeps the model under ~85 MB while preserving good audio quality. */
export const KOKORO_DTYPE = 'q8';

export const KOKORO_VOICES: VoiceOption[] = [
    { id: 'af_alloy', label: 'Alloy', lang: 'en-US', description: 'American Female · Default', engine: 'kokoro' },
    { id: 'af_heart', label: 'Heart', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_aoede', label: 'Aoede', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_bella', label: 'Bella', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_jessica', label: 'Jessica', lang: 'en-US', description: 'American Female · Soft', engine: 'kokoro' },
    { id: 'af_kore', label: 'Kore', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_nicole', label: 'Nicole', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_nova', label: 'Nova', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_river', label: 'Riva', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_sarah', label: 'Serah', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'af_sky', label: 'Sky', lang: 'en-US', description: 'American Female', engine: 'kokoro' },
    { id: 'am_adam', label: 'Adam', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_echo', label: 'Echo', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_eric', label: 'Eric', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_fenrir', label: 'Fenrir', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_liam', label: 'Liam', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_michael', label: 'Michael', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_onyx', label: 'Onyx', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_puck', label: 'Puck', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'am_santa', label: 'Santa', lang: 'en-US', description: 'American Male', engine: 'kokoro' },
    { id: 'bf_alice', label: 'Alice', lang: 'en-GB', description: 'British Female', engine: 'kokoro' },
    { id: 'bf_emma', label: 'Emma', lang: 'en-GB', description: 'British Female', engine: 'kokoro' },
    { id: 'bf_isabella', label: 'Isabella', lang: 'en-GB', description: 'British Female', engine: 'kokoro' },
    { id: 'bf_lily', label: 'Lily', lang: 'en-GB', description: 'British Female', engine: 'kokoro' },
    { id: 'bm_daniel', label: 'Daniel', lang: 'en-GB', description: 'British Male', engine: 'kokoro' },
    { id: 'bm_fable', label: 'Fable', lang: 'en-GB', description: 'British Male', engine: 'kokoro' },
    { id: 'bm_george', label: 'George', lang: 'en-GB', description: 'British Male', engine: 'kokoro' },
    { id: 'bm_lewis', label: 'Lewis', lang: 'en-GB', description: 'British Male', engine: 'kokoro' },
];

export const DEFAULT_KOKORO_VOICE = 'af_alloy';
