import { spawn, ChildProcess, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type RecorderKind = 'sox' | 'ffmpeg' | 'arecord';

export interface DetectedRecorder {
    kind: RecorderKind;
    command: string;
}

export interface RecordingResult {
    audio: string;   // base64
    mimeType: string;
    bytes: number;
}

/**
 * Records microphone audio in the extension host using a native CLI tool.
 * This exists because VS Code webviews do not grant `microphone` permission
 * to their sandboxed iframe, so Browser Audio API is unusable for capture.
 */
export class HostAudioRecorder {
    private process: ChildProcess | null = null;
    private outputPath: string | null = null;
    private recorder: DetectedRecorder | null = null;

    /** Detect the first available recorder on PATH. */
    static async detect(): Promise<DetectedRecorder | null> {
        const platform = os.platform();

        // Preferred order per platform.
        const candidates: RecorderKind[] =
            platform === 'darwin' ? ['sox', 'ffmpeg'] :
                platform === 'win32' ? ['sox', 'ffmpeg'] :
                    ['arecord', 'sox', 'ffmpeg'];

        for (const kind of candidates) {
            const cmd = await which(kind);
            if (cmd) {
                return { kind, command: cmd };
            }
        }
        return null;
    }

    /** Build the human-readable install hint for the detected platform. */
    static installHint(): string {
        const platform = os.platform();
        if (platform === 'darwin') {
            return 'Install sox (recommended): `brew install sox` — or ffmpeg: `brew install ffmpeg`.';
        }
        if (platform === 'win32') {
            return 'Install sox from https://sourceforge.net/projects/sox/ or ffmpeg from https://ffmpeg.org/download.html, and add it to PATH.';
        }
        return 'Install via your package manager, e.g. `sudo apt install sox` or `sudo apt install alsa-utils ffmpeg`.';
    }

    isRecording(): boolean {
        return this.process !== null;
    }

    /** Start recording to a temp WAV file. Throws if no recorder is available. */
    async start(): Promise<DetectedRecorder> {
        if (this.process) {
            throw new Error('Recording already in progress.');
        }

        const recorder = await HostAudioRecorder.detect();
        if (!recorder) {
            throw new Error(
                `No audio recorder found on PATH (looked for sox, ffmpeg, arecord). ${HostAudioRecorder.installHint()}`,
            );
        }
        this.recorder = recorder;

        const tmpFile = path.join(
            os.tmpdir(),
            `codearchy-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
        );
        this.outputPath = tmpFile;

        const args = buildArgs(recorder.kind, tmpFile);
        const proc = spawn(recorder.command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Consume streams so the process doesn't block.
        proc.stdout?.on('data', () => { /* ignore */ });
        proc.stderr?.on('data', () => { /* ignore */ });

        let spawnErr: Error | null = null;
        proc.on('error', (err) => { spawnErr = err; });

        // Give the process a brief moment to fail fast if the binary is broken.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        if (spawnErr) {
            this.cleanup();
            throw new Error(`Failed to start ${recorder.kind}: ${(spawnErr as Error).message}`);
        }
        if (proc.exitCode !== null && proc.exitCode !== 0) {
            this.cleanup();
            throw new Error(`${recorder.kind} exited immediately with code ${proc.exitCode}.`);
        }

        this.process = proc;
        return recorder;
    }

    /** Stop recording and return the captured audio as base64. */
    async stop(): Promise<RecordingResult> {
        const proc = this.process;
        const filePath = this.outputPath;
        const recorder = this.recorder;

        if (!proc || !filePath || !recorder) {
            throw new Error('No active recording to stop.');
        }

        // Signal the process to stop gracefully. ffmpeg responds to 'q' on stdin
        // but since we closed stdin, SIGINT is the portable choice for all three.
        await new Promise<void>((resolve) => {
            const onExit = () => resolve();
            proc.once('exit', onExit);
            proc.once('close', onExit);
            try {
                if (os.platform() === 'win32') {
                    proc.kill();
                } else {
                    proc.kill('SIGINT');
                }
            } catch {
                resolve();
            }
            // Safety: force-resolve if process is slow to exit.
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                resolve();
            }, 2000);
        });

        this.process = null;

        try {
            const buffer = await fs.promises.readFile(filePath);
            if (buffer.length === 0) {
                throw new Error('Recorded audio file is empty.');
            }
            return {
                audio: buffer.toString('base64'),
                mimeType: 'audio/wav',
                bytes: buffer.length,
            };
        } finally {
            // Best-effort cleanup of temp file.
            fs.promises.unlink(filePath).catch(() => { /* ignore */ });
            this.outputPath = null;
            this.recorder = null;
        }
    }

    /** Abort a recording without producing audio output. */
    cancel(): void {
        if (this.process) {
            try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
        }
        this.cleanup();
    }

    private cleanup(): void {
        this.process = null;
        if (this.outputPath) {
            fs.promises.unlink(this.outputPath).catch(() => { /* ignore */ });
            this.outputPath = null;
        }
        this.recorder = null;
    }
}

function buildArgs(kind: RecorderKind, outputPath: string): string[] {
    switch (kind) {
        case 'sox':
            // sox: -d = default input device; -c 1 mono; -r 16000 Hz; -b 16 bit.
            return [
                '-d',
                '-c', '1',
                '-r', '16000',
                '-b', '16',
                outputPath,
            ];
        case 'ffmpeg': {
            const platform = os.platform();
            if (platform === 'darwin') {
                // AVFoundation: ":0" selects default audio input, no video.
                return [
                    '-y',
                    '-f', 'avfoundation',
                    '-i', ':0',
                    '-ac', '1',
                    '-ar', '16000',
                    outputPath,
                ];
            }
            if (platform === 'win32') {
                // DirectShow requires a device name; fall back to WASAPI default.
                return [
                    '-y',
                    '-f', 'dshow',
                    '-i', 'audio=default',
                    '-ac', '1',
                    '-ar', '16000',
                    outputPath,
                ];
            }
            // Linux: ALSA default.
            return [
                '-y',
                '-f', 'alsa',
                '-i', 'default',
                '-ac', '1',
                '-ar', '16000',
                outputPath,
            ];
        }
        case 'arecord':
            // ALSA: CD-quality-ish mono 16 kHz.
            return [
                '-f', 'S16_LE',
                '-c', '1',
                '-r', '16000',
                outputPath,
            ];
    }
}

/** Cross-platform `which`. Returns absolute path to binary or null. */
function which(cmd: string): Promise<string | null> {
    return new Promise((resolve) => {
        const finder = os.platform() === 'win32' ? 'where' : 'which';
        execFile(finder, [cmd], (err, stdout) => {
            if (err) {
                resolve(null);
                return;
            }
            const first = stdout.toString().split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
            resolve(first ?? null);
        });
    });
}
