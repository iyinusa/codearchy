import React, { useState, useRef, useEffect, useCallback } from 'react';
import { postMessage } from '../vscode';
import type { ChatMessage } from '../types';
import { Icon } from './Icons';
import {
    appendConversationMessage,
    updateConversationMessage,
    updateConversationMessageVoice,
    arrayBufferToPcm,
    deleteConversationMessage,
    clearConversation,
    loadConversation,
    useProjectId,
} from '../db';
import {
    speak as ttsSpeak,
    stopSpeaking,
    subscribeSpeaking,
    synthesizeKokoroAudio,
    playCachedAudio,
    isKokoroActive,
    getActiveKokoroVoiceId,
} from '../voice/ttsManager';

interface ChatPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    /** Called the moment a `generateNarrator` request leaves the panel
     *  so the host can show a shimmer placeholder in the narrations
     *  list while the AI is still building the timeline. */
    onNarratorGenerationStart?: () => void;
}

export function ChatPanel({ isOpen, onToggle, onNarratorGenerationStart }: ChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [thinkingText, setThinkingText] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Voice-cache build progress for assistant messages, keyed by
     *  message id. Surfaces as a ring around the speak button so the
     *  user can see when audio is ready to play. Removed once the
     *  cache is written; absence == ready. */
    const [voiceProgress, setVoiceProgress] = useState<
        Record<number, { done: number; total: number }>
    >({});
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const autoSpeakOnNextReplyRef = useRef(false);
    const isAtBottomRef = useRef(true);
    const projectId = useProjectId();
    const projectIdRef = useRef<string | null>(projectId);
    projectIdRef.current = projectId;
    const messagesRef = useRef<ChatMessage[]>([]);
    messagesRef.current = messages;

    // Hydrate conversation from DexieJS whenever the active project changes
    // (e.g. the user opens a different workspace in the same session). All
    // persisted messages become visible immediately; the extension host's
    // in-memory Ollama history is rebuilt in parallel so context is aligned.
    useEffect(() => {
        if (!projectId) {
            setMessages([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const records = await loadConversation(projectId);
                if (cancelled) return;
                const hydrated: ChatMessage[] = records.map(r => ({
                    id: r.id,
                    role: r.role,
                    content: r.content,
                    timestamp: r.timestamp,
                    voice: r.voice,
                    voiceId: r.voiceId,
                    voiceSampleRate: r.voiceSampleRate,
                }));
                setMessages(hydrated);
                // Push history to host so the model context window matches
                // what the user sees after a refresh / workspace change.
                postMessage('syncChatHistory', {
                    history: hydrated.map(m => ({
                        role: m.role,
                        content: m.content,
                        timestamp: m.timestamp,
                    })),
                });
            } catch (e) {
                console.error('[CodeArchy] loadConversation failed', e);
            }
        })();
        return () => { cancelled = true; };
    }, [projectId]);

    /** Push the current message list (without streaming flags) to the host so
     *  the LLM conversation history stays in sync after deletes/edits. */
    const syncHistoryToHost = useCallback((list: ChatMessage[]) => {
        postMessage('syncChatHistory', {
            history: list
                .filter(m => !m.isStreaming)
                .map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
        });
    }, []);

    // Auto-scroll only when the user is at/near the bottom.
    // Use instant scrollTop (not smooth) so rapid streaming chunks don't
    // spawn competing animations that fight the user's manual scroll.
    useEffect(() => {
        if (isAtBottomRef.current) {
            const container = messagesContainerRef.current;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [messages]);

    // When the chat panel opens, always scroll to the bottom so the user sees
    // the latest messages rather than the top of the history.
    useEffect(() => {
        if (!isOpen) return;
        isAtBottomRef.current = true;
        // Defer one frame so the panel has transitioned to visible and the
        // container's scrollHeight reflects the full content height.
        requestAnimationFrame(() => {
            const container = messagesContainerRef.current;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        });
    }, [isOpen]);

    const handleMessagesScroll = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        isAtBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }, []);

    const speakNow = useCallback((text: string) => {
        if (!text.trim()) return;
        // Delegate to the unified TTS manager. It picks the right engine
        // (Web Speech or lazy-loaded Kokoro) based on the user's voice
        // configuration. The `subscribeSpeaking` hook below keeps the
        // speaker icon state in sync regardless of which engine ran.
        void ttsSpeak(text, {
            onError: () => setIsSpeaking(false),
        });
    }, []);

    /**
     * Cache-aware playback for an assistant message.
     *  - Kokoro engine + matching cached PCM → instant playback (no overlay).
     *  - Kokoro engine + stale-or-missing PCM → synthesise via the cache,
     *    persist, update React state, then play. While synthesising the
     *    `synthesizeKokoroAudio` helper does NOT toggle the synthesizing
     *    overlay — feels like a normal TTS even though it took seconds.
     *  - Web Speech engine → unchanged streaming path via ttsSpeak.
     */
    const speakMessage = useCallback((msg: ChatMessage) => {
        if (!msg.content.trim()) return;
        const activeVoice = getActiveKokoroVoiceId();
        if (!isKokoroActive()) {
            speakNow(msg.content);
            return;
        }
        // Cache hit: voice id matches → play raw PCM immediately.
        if (msg.voice && msg.voiceSampleRate && msg.voiceId === activeVoice) {
            const pcm = arrayBufferToPcm(msg.voice);
            void playCachedAudio(pcm, msg.voiceSampleRate, {
                onError: () => setIsSpeaking(false),
            });
            return;
        }
        // Cache miss / mismatch: re-synthesise with the active voice and
        // persist back so future plays are instant. While the synth runs
        // we publish per-chunk progress to `voiceProgress` so the speak
        // button shows a ring filling up to ready — gives the user visual
        // feedback that audio is being prepared.
        (async () => {
            const msgId = msg.id;
            const onProgress = msgId !== undefined
                ? (done: number, total: number) =>
                    setVoiceProgress(p => ({ ...p, [msgId]: { done, total } }))
                : undefined;
            const audio = await synthesizeKokoroAudio(msg.content, activeVoice, onProgress);
            if (msgId !== undefined) {
                setVoiceProgress(p => {
                    if (!(msgId in p)) return p;
                    const next = { ...p };
                    delete next[msgId];
                    return next;
                });
            }
            if (!audio) {
                // Kokoro failed → fall back to streaming engine so the user
                // still hears the answer.
                speakNow(msg.content);
                return;
            }
            // Patch the cache for this message so subsequent clicks are
            // instant. Both DB and in-memory state get the new buffer.
            // Cast required: lib.dom now types `TypedArray.buffer` as
            // `ArrayBuffer | SharedArrayBuffer`; our PCM is always backed
            // by a non-shared ArrayBuffer at runtime.
            const buffer = audio.pcm.buffer.slice(
                audio.pcm.byteOffset,
                audio.pcm.byteOffset + audio.pcm.byteLength,
            ) as ArrayBuffer;
            if (msgId !== undefined) {
                updateConversationMessageVoice(msgId, audio).catch(e =>
                    console.error('[CodeArchy] persist message voice failed', e),
                );
            }
            setMessages(cur => cur.map(m =>
                m.id !== undefined && m.id === msgId
                    ? { ...m, voice: buffer, voiceId: audio.voiceId, voiceSampleRate: audio.sampleRate }
                    : m,
            ));
            void playCachedAudio(audio.pcm, audio.sampleRate, {
                onError: () => setIsSpeaking(false),
            });
        })();
    }, [speakNow]);

    // Mirror the TTS manager's speaking state into local UI state so the
    // speaker / stop icon swaps correctly even when Kokoro audio playback
    // ends asynchronously.
    useEffect(() => subscribeSpeaking(setIsSpeaking), []);

    // Listen for chat responses
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            switch (msg.type) {
                case 'chatChunk': {
                    const chunk = msg.payload as { content: string };
                    setIsThinking(false);
                    setThinkingText('');
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === 'assistant' && last.isStreaming) {
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: last.content + chunk.content },
                            ];
                        }
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: chunk.content,
                                timestamp: Date.now(),
                                isStreaming: true,
                            },
                        ];
                    });
                    break;
                }
                case 'chatResponse': {
                    const response = msg.payload as { content: string; error?: string };
                    setIsThinking(false);
                    setThinkingText('');
                    if (response.error) {
                        autoSpeakOnNextReplyRef.current = false;
                        setError(response.error);
                        setIsStreaming(false);
                        return;
                    }
                    // Snapshot auto-speak intent now — when Kokoro is the
                    // active engine we route playback through the cache
                    // pre-synth task instead of the streaming speakNow().
                    const wantsAutoSpeak = autoSpeakOnNextReplyRef.current;
                    autoSpeakOnNextReplyRef.current = false;
                    const kokoroPath = isKokoroActive();
                    // Finalize the streaming assistant message (or append a
                    // new one if nothing streamed) and persist it to the DB.
                    const pid = projectIdRef.current;
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        const finalizedContent = response.content;
                        let next: ChatMessage[];
                        let finalized: ChatMessage;
                        if (last && last.role === 'assistant' && last.isStreaming) {
                            finalized = { ...last, content: finalizedContent, isStreaming: false };
                            next = [...prev.slice(0, -1), finalized];
                        } else {
                            finalized = {
                                role: 'assistant',
                                content: finalizedContent,
                                timestamp: Date.now(),
                                isStreaming: false,
                            };
                            next = [...prev, finalized];
                        }
                        if (pid) {
                            (async () => {
                                let messageId: number | undefined = finalized.id;
                                try {
                                    if (finalized.id !== undefined) {
                                        await updateConversationMessage(finalized.id, {
                                            content: finalized.content,
                                        });
                                    } else {
                                        const id = await appendConversationMessage(pid, {
                                            role: finalized.role,
                                            content: finalized.content,
                                            timestamp: finalized.timestamp,
                                        });
                                        messageId = id;
                                        // Patch the id back into state once persisted.
                                        setMessages(cur => cur.map(m =>
                                            m === finalized || (m.timestamp === finalized.timestamp && m.role === finalized.role && m.id === undefined)
                                                ? { ...m, id }
                                                : m,
                                        ));
                                    }
                                } catch (e) {
                                    console.error('[CodeArchy] persist assistant failed', e);
                                }
                                // Background voice cache: synthesise the
                                // assistant reply and store the PCM so any
                                // future playback (or the auto-speak path
                                // below) is instant. Streaming output stays
                                // untouched — the cache job runs silently
                                // in parallel with the user reading the text.
                                if (kokoroPath) {
                                    const voiceId = getActiveKokoroVoiceId();
                                    // Track per-chunk synth progress so the
                                    // assistant row can render a ring around
                                    // its speak button while audio is being
                                    // prepared in the background.
                                    const onProgress = messageId !== undefined
                                        ? (done: number, total: number) =>
                                            setVoiceProgress(p => ({
                                                ...p,
                                                [messageId as number]: { done, total },
                                            }))
                                        : undefined;
                                    const audio = await synthesizeKokoroAudio(
                                        finalized.content,
                                        voiceId,
                                        onProgress,
                                    );
                                    if (messageId !== undefined) {
                                        setVoiceProgress(p => {
                                            if (!(messageId in p)) return p;
                                            const next = { ...p };
                                            delete next[messageId as number];
                                            return next;
                                        });
                                    }
                                    if (audio) {
                                        const buffer = audio.pcm.buffer.slice(
                                            audio.pcm.byteOffset,
                                            audio.pcm.byteOffset + audio.pcm.byteLength,
                                        ) as ArrayBuffer;
                                        if (messageId !== undefined) {
                                            updateConversationMessageVoice(messageId, audio).catch(e =>
                                                console.error('[CodeArchy] persist message voice failed', e),
                                            );
                                        }
                                        setMessages(cur => cur.map(m =>
                                            (messageId !== undefined && m.id === messageId)
                                                || (m === finalized)
                                                ? { ...m, voice: buffer, voiceId: audio.voiceId, voiceSampleRate: audio.sampleRate }
                                                : m,
                                        ));
                                        if (wantsAutoSpeak) {
                                            // Voice-input auto-reply: play
                                            // the cached PCM the moment it's
                                            // ready. Feels like classic TTS.
                                            void playCachedAudio(audio.pcm, audio.sampleRate, {
                                                onError: () => setIsSpeaking(false),
                                            });
                                        }
                                    } else if (wantsAutoSpeak) {
                                        // Synthesis failed → fall back so
                                        // the user still hears the answer.
                                        speakNow(finalized.content);
                                    }
                                }
                            })();
                        }
                        return next;
                    });
                    setIsStreaming(false);
                    // Web-Speech path keeps the original streaming behaviour
                    // — audio starts immediately, no cache involved.
                    if (wantsAutoSpeak && !kokoroPath) {
                        speakNow(response.content);
                    }
                    // Fire-and-forget narrator generation: ask the host to
                    // silently produce a story-player timeline for this Q&A.
                    // The host answers back with a `narratorGenerated` event
                    // that App.tsx persists; failures are swallowed upstream.
                    try {
                        const history = messagesRef.current;
                        let lastUser = '';
                        let answerTs = Date.now();
                        for (let i = history.length - 1; i >= 0; i--) {
                            const m = history[i];
                            if (m.role === 'assistant' && !m.isStreaming) answerTs = m.timestamp;
                            if (m.role === 'user') { lastUser = m.content; break; }
                        }
                        if (lastUser && response.content) {
                            // Notify host so the narrator list shows a
                            // shimmer placeholder while the AI builds the
                            // timeline — gives the user instant feedback.
                            onNarratorGenerationStart?.();
                            postMessage('generateNarrator', {
                                question: lastUser,
                                answer: response.content,
                                messageTimestamp: answerTs,
                            });
                        }
                    } catch {
                        /* narrator generation is best-effort */
                    }
                    break;
                }
                case 'chatThinking': {
                    const think = msg.payload as { content: string };
                    setThinkingText((prev) => prev + think.content);
                    break;
                }
                case 'error': {
                    const errPayload = msg.payload as { message: string };
                    setError(errPayload.message);
                    setIsStreaming(false);
                    setIsThinking(false);
                    setThinkingText('');
                    break;
                }
                case 'voiceRecordingState': {
                    const s = msg.payload as { state: 'recording' | 'transcribing' | 'error'; error?: string; recorder?: string };
                    if (s.state === 'recording') {
                        setIsRecording(true);
                        setIsTranscribing(false);
                        setError(null);
                    } else if (s.state === 'transcribing') {
                        setIsRecording(false);
                        setIsTranscribing(true);
                    } else if (s.state === 'error') {
                        setIsRecording(false);
                        setIsTranscribing(false);
                        setError(s.error || 'Voice recording failed.');
                    }
                    break;
                }
                case 'voiceTranscript': {
                    const vt = msg.payload as { transcript?: string; error?: string };
                    setIsTranscribing(false);
                    setIsRecording(false);
                    if (vt.error) {
                        setError(vt.error);
                    } else if (vt.transcript?.trim()) {
                        const transcript = vt.transcript.trim();
                        autoSpeakOnNextReplyRef.current = true;

                        const userMsg: ChatMessage = {
                            role: 'user',
                            content: transcript,
                            timestamp: Date.now(),
                        };
                        setMessages((prev) => [...prev, userMsg]);
                        setInput('');
                        setIsStreaming(true);
                        setIsThinking(true);
                        setThinkingText('');
                        setError(null);
                        isAtBottomRef.current = true;

                        // Persist voice-originated user message too.
                        const pid = projectIdRef.current;
                        if (pid) {
                            (async () => {
                                try {
                                    const id = await appendConversationMessage(pid, {
                                        role: 'user',
                                        content: userMsg.content,
                                        timestamp: userMsg.timestamp,
                                    });
                                    setMessages(cur => cur.map(m =>
                                        m.timestamp === userMsg.timestamp && m.role === 'user' && m.id === undefined
                                            ? { ...m, id }
                                            : m,
                                    ));
                                } catch (e) {
                                    console.error('[CodeArchy] persist voice user failed', e);
                                }
                            })();
                        }

                        postMessage('chatMessage', { content: transcript });
                    } else {
                        setError('No speech detected. Please try again.');
                    }
                    break;
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [speakNow]);

    const sendMessage = useCallback(
        (text: string) => {
            if (!text.trim() || isStreaming) return;

            const userMsg: ChatMessage = {
                role: 'user',
                content: text.trim(),
                timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, userMsg]);
            setInput('');
            setIsStreaming(true);
            setIsThinking(true);
            setThinkingText('');
            setError(null);
            isAtBottomRef.current = true;

            // Persist the user message immediately so it survives webview
            // reloads even if the assistant reply never arrives (network
            // failure, Ollama crash, etc.).
            const pid = projectIdRef.current;
            if (pid) {
                (async () => {
                    try {
                        const id = await appendConversationMessage(pid, {
                            role: 'user',
                            content: userMsg.content,
                            timestamp: userMsg.timestamp,
                        });
                        setMessages(cur => cur.map(m =>
                            m.timestamp === userMsg.timestamp && m.role === 'user' && m.id === undefined
                                ? { ...m, id }
                                : m,
                        ));
                    } catch (e) {
                        console.error('[CodeArchy] persist user failed', e);
                    }
                })();
            }

            postMessage('chatMessage', { content: text.trim() });
        },
        [isStreaming]
    );

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    };

    const clearChat = () => {
        setMessages([]);
        setError(null);
        postMessage('clearChat');
        const pid = projectIdRef.current;
        if (pid) {
            clearConversation(pid).catch(e =>
                console.error('[CodeArchy] clearConversation failed', e),
            );
        }
    };

    /** Remove a single message from the UI, DexieJS store, and the host-side
     *  Ollama conversation context so subsequent turns never reference it. */
    const deleteMessage = useCallback(
        (msg: ChatMessage) => {
            if (msg.isStreaming) return;
            setMessages(prev => {
                const next = prev.filter(m => m !== msg);
                syncHistoryToHost(next);
                return next;
            });
            if (msg.id !== undefined) {
                deleteConversationMessage(msg.id).catch(e =>
                    console.error('[CodeArchy] deleteConversationMessage failed', e),
                );
            }
        },
        [syncHistoryToHost],
    );

    // --- Audio: Voice Input via Extension Host ---
    // Webview iframes do not grant microphone permission, so capture runs in
    // the extension host using a native CLI recorder (sox/ffmpeg/arecord).
    // The webview only sends start/stop messages and listens for state updates.
    const toggleRecording = useCallback(() => {
        if (isRecording) {
            postMessage('stopVoiceRecording');
            // Keep isRecording=true until the host confirms 'transcribing';
            // this avoids a flash back to the idle icon between stop and the
            // spinner. The voiceRecordingState handler clears it.
            return;
        }
        setError(null);
        postMessage('startVoiceRecording');
    }, [isRecording]);

    // --- Audio: Text-to-Speech ---
    // Toggle playback for an assistant message. Routes through the
    // cache-aware `speakMessage` helper so Kokoro plays from IndexedDB
    // when available and only re-synthesises when the active voice
    // changed (or no cache exists yet).
    const speakText = useCallback(
        (msg: ChatMessage) => {
            if (isSpeaking) {
                stopSpeaking();
                setIsSpeaking(false);
                return;
            }
            speakMessage(msg);
        },
        [isSpeaking, speakMessage]
    );

    if (!isOpen) {
        return (
            <button className="chat-fab" onClick={onToggle} title="Open Architecture Chat">
                <Icon name="chatFab" size="lg" />
            </button>
        );
    }

    return (
        <div className={`chat-panel${isExpanded ? ' chat-panel-expanded' : ''}`}>
            <div className="chat-header">
                <div className="chat-header-left">
                    <Icon name="systemView" className="chat-header-icon" />
                    <h3>Architecture Assistant</h3>
                </div>
                <div className="chat-header-actions">
                    <button className="chat-action-btn" onClick={clearChat} title="Clear conversation">
                        <Icon name="clearChat" />
                    </button>
                    <button
                        className="chat-action-btn"
                        onClick={() => setIsExpanded((v) => !v)}
                        title={isExpanded ? 'Collapse panel' : 'Expand panel'}
                    >
                        <Icon name={isExpanded ? 'collapsePanel' : 'expandPanel'} />
                    </button>
                    <button className="chat-action-btn" onClick={onToggle} title="Minimize">
                        <Icon name="minimize" />
                    </button>
                </div>
            </div>

            <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
                {messages.length === 0 && (
                    <div className="chat-welcome">
                        <div className="chat-welcome-icon">
                            <Icon name="systemView" size="2x" />
                        </div>
                        <h4>Architecture Assistant</h4>
                        <p>Ask questions about your codebase architecture, subsystems, dependencies, and design patterns.</p>
                        <div className="chat-suggestions">
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('What is the overall architecture of this codebase?')}
                            >
                                What is the overall architecture?
                            </button>
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('Explain the main subsystems and their responsibilities.')}
                            >
                                Explain the main subsystems
                            </button>
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('What are the key dependencies between components?')}
                            >
                                Key dependencies between components
                            </button>
                        </div>
                    </div>
                )}

                {messages.map((msg, i) => (
                    <div key={msg.id ?? `local-${i}-${msg.timestamp}`} className={`chat-message chat-message-${msg.role}`}>
                        <div className="chat-message-avatar">
                            {msg.role === 'user' ? (
                                <Icon name="userAvatar" />
                            ) : (
                                window.CODEARCY_ICON_URI
                                    ? <img src={window.CODEARCY_ICON_URI} alt="CodeArchy" className="chat-avatar-icon" />
                                    : <Icon name="botAvatar" />
                            )}
                        </div>
                        <div className="chat-message-content">
                            <div className="chat-message-text">
                                {formatMessage(msg.content)}
                                {msg.isStreaming && <span className="chat-cursor">▊</span>}
                            </div>
                            <div className="chat-message-actions">
                                {msg.role === 'assistant' && !msg.isStreaming && (() => {
                                    const prog = msg.id !== undefined ? voiceProgress[msg.id] : undefined;
                                    const pct = prog && prog.total > 0
                                        ? Math.round((prog.done / prog.total) * 100)
                                        : 0;
                                    const isPreparing = !!prog;
                                    return (
                                        <button
                                            className={`chat-speak-btn${isPreparing ? ' preparing' : ''}`}
                                            onClick={() => speakText(msg)}
                                            title={
                                                isPreparing
                                                    ? `Preparing voice… ${pct}%`
                                                    : isSpeaking
                                                        ? 'Stop speaking'
                                                        : 'Read aloud'
                                            }
                                            style={isPreparing
                                                ? ({ ['--voice-progress' as string]: `${pct}%` } as React.CSSProperties)
                                                : undefined}
                                            disabled={isPreparing}
                                        >
                                            <span className="chat-speak-ring" aria-hidden="true" />
                                            <Icon name={isSpeaking ? 'stopAction' : 'speakAloud'} />
                                        </button>
                                    );
                                })()}
                                {!msg.isStreaming && (
                                    <button
                                        className="chat-delete-btn"
                                        onClick={() => deleteMessage(msg)}
                                        title="Delete this message"
                                    >
                                        <Icon name="close" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                ))}

                {isThinking && (
                    <div className="chat-message chat-message-assistant">
                        <div className="chat-message-avatar">
                            {window.CODEARCY_ICON_URI
                                ? <img src={window.CODEARCY_ICON_URI} alt="CodeArchy" className="chat-avatar-icon" />
                                : <Icon name="botAvatar" />}
                        </div>
                        <div className="chat-message-content">
                            <div className="chat-message-text chat-thinking-bubble">
                                <ThinkingBubble text={thinkingText} />
                            </div>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="chat-error">
                        <Icon name="warning" className="chat-error-icon" />
                        <span>{error}</span>
                        <button className="chat-error-dismiss" onClick={() => setError(null)}>
                            <Icon name="close" />
                        </button>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
                <textarea
                    ref={inputRef}
                    className="chat-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isStreaming ? 'Waiting for response...' : 'Ask about the architecture...'}
                    disabled={isStreaming}
                    rows={1}
                />
                <div className="chat-input-actions">
                    {/* <button
                        className={`chat-voice-btn ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
                        onClick={toggleRecording}
                        title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing…' : 'Voice input'}
                        disabled={isStreaming || isTranscribing}
                    >
                        {isTranscribing
                            ? <Icon name="spinner" spin />
                            : <Icon name={isRecording ? 'stopAction' : 'voiceInput'} />
                        }
                    </button> */}
                    <button
                        className="chat-send-btn"
                        onClick={() => sendMessage(input)}
                        disabled={!input.trim() || isStreaming}
                        title="Send message"
                    >
                        {isStreaming ? (
                            <Icon name="spinner" spin />
                        ) : (
                            <Icon name="send" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Thinking indicator.
 * - When the model streams thinking tokens, displays them verbatim with a cursor.
 * - When no thinking tokens have arrived yet, shows a single animated "Thinking…" fallback.
 */
function ThinkingBubble({ text }: { text: string }) {
    if (text) {
        // Real reasoning streamed from the model — apply full markdown formatting
        return (
            <div className="chat-thinking-text">
                <span className="chat-thinking-label">Reasoning</span>
                <div className="chat-thinking-stream">
                    {formatMessage(text)}<span className="chat-cursor">▊</span>
                </div>
            </div>
        );
    }

    // Fallback: single animated label — no cycling phrases
    return (
        <span className="chat-thinking-text">
            <span className="chat-thinking-label">Thinking</span>
        </span>
    );
}

/** Full markdown formatter: headers, lists, tables, code blocks, bold, italic, inline code */
// ── LaTeX / math symbol sanitizer ─────────────────────────────────────────────
// Gemma occasionally emits LaTeX math notation — from simple $\rightarrow$ to
// full command sequences like \xrightarrow{\text{label}}. Convert all to
// Unicode / plain text so the chat panel renders cleanly.
function sanitizeLatex(text: string): string {
    let out = text;

    // Stage 1: named arrows with optional label (most specific — handle first
    //   so \xrightarrow{\text{Trigger}} → \xrightarrow{Trigger} → →[Trigger])
    out = out.replace(/\\xrightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `→[${l.trim()}]` : '→');
    out = out.replace(/\\xleftarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `←[${l.trim()}]` : '←');
    out = out.replace(/\\xRightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `⇒[${l.trim()}]` : '⇒');
    out = out.replace(/\\xLeftarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `⇐[${l.trim()}]` : '⇐');
    out = out.replace(/\\xleftrightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `↔[${l.trim()}]` : '↔');

    // Stage 2: unwrap \text{…} and common math/text wrappers
    out = out.replace(/\\text\{([^{}]*)\}/g, '$1');
    out = out.replace(/\\(?:mathbf|mathit|mathcal|mathrm|mathsf|mathtt|boldsymbol|textbf|textit|texttt|textrm|emph)\{([^{}]*)\}/g, '$1');

    // Stage 3: $…$-delimited symbol shorthands
    out = out.replace(/\$\\rightarrow\$/g, '→');
    out = out.replace(/\$\\leftarrow\$/g, '←');
    out = out.replace(/\$\\Rightarrow\$/g, '⇒');
    out = out.replace(/\$\\Leftarrow\$/g, '⇐');
    out = out.replace(/\$\\leftrightarrow\$/g, '↔');
    out = out.replace(/\$\\Leftrightarrow\$/g, '⟺');
    out = out.replace(/\$\\uparrow\$/g, '↑');
    out = out.replace(/\$\\downarrow\$/g, '↓');
    out = out.replace(/\$\\to\$/g, '→');
    out = out.replace(/\$\\gets\$/g, '←');
    out = out.replace(/\$\\geq\$/g, '≥');
    out = out.replace(/\$\\leq\$/g, '≤');
    out = out.replace(/\$\\neq\$/g, '≠');
    out = out.replace(/\$\\approx\$/g, '≈');
    out = out.replace(/\$\\times\$/g, '×');
    out = out.replace(/\$\\cdot\$/g, '·');
    out = out.replace(/\$\\infty\$/g, '∞');
    out = out.replace(/\$\\alpha\$/g, 'α');
    out = out.replace(/\$\\beta\$/g, 'β');
    out = out.replace(/\$\\gamma\$/g, 'γ');
    out = out.replace(/\$\\delta\$/g, 'δ');
    // Strip remaining $$…$$ or $…$ fences, keeping inner text
    out = out.replace(/\$\$([^$]+)\$\$/g, '$1');
    out = out.replace(/\$([^$\n]+)\$/g, '$1');

    // Stage 4: catch-all — any remaining \command{content} → content
    out = out.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
    // Lone \command (no braces) — remove
    out = out.replace(/\\[a-zA-Z]+\b/g, '');

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────

function formatMessage(text: string): React.ReactNode {
    const lines = sanitizeLatex(text).split('\n');
    const nodes: React.ReactNode[] = [];
    let i = 0;
    let k = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Code fence
        if (line.trimStart().startsWith('```')) {
            const lang = line.trimStart().slice(3).trim();
            const codeLines: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            nodes.push(
                <pre key={k++} className="chat-code-block">
                    {lang && <span className="chat-code-lang">{lang}</span>}
                    <code>{codeLines.join('\n')}</code>
                </pre>
            );
            i++; // skip closing fence (or advance past end if unclosed)
            continue;
        }

        // Headings
        const hMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (hMatch) {
            const level = Math.min(hMatch[1].length, 3);
            const content = inlineFormat(hMatch[2]);
            const key = k++;
            if (level === 1) nodes.push(<h4 key={key} className="chat-md-h1">{content}</h4>);
            else if (level === 2) nodes.push(<h5 key={key} className="chat-md-h2">{content}</h5>);
            else nodes.push(<h6 key={key} className="chat-md-h3">{content}</h6>);
            i++;
            continue;
        }

        // Table (lines starting with |)
        if (line.startsWith('|')) {
            const tableLines: string[] = [];
            while (i < lines.length && lines[i].startsWith('|')) {
                tableLines.push(lines[i]);
                i++;
            }
            nodes.push(<MdTable key={k++} lines={tableLines} />);
            continue;
        }

        // Unordered list (- item, * item, + item)
        if (/^(\s*)[-*+] /.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^(\s*)[-*+] /.test(lines[i])) {
                items.push(lines[i].replace(/^(\s*)[-*+] /, ''));
                i++;
            }
            nodes.push(
                <ul key={k++} className="chat-md-ul">
                    {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
                </ul>
            );
            continue;
        }

        // Ordered list (1. item)
        // Many local models (Gemma included) emit ordered list items separated
        // by blank lines AND/OR with the literal "1." marker on every item
        // ("1. … 1. … 1. …"). Two fixes here:
        //   (a) collect items across blank-line gaps as long as the next
        //       non-blank line is also a numbered item — keeps them in a
        //       single <ol> so the CSS `list-style-type: decimal` counter
        //       produces 1, 2, 3, … instead of 1, 1, 1, …
        //   (b) we deliberately ignore the model's literal number — the
        //       browser's auto-numbering supplies the correct sequence,
        //       which also self-corrects "1., 2., 1., 3." style sloppiness.
        if (/^\s*\d+\.\s/.test(line)) {
            const items: string[] = [];
            // First item.
            items.push(lines[i].replace(/^\s*\d+\.\s/, ''));
            i++;
            while (i < lines.length) {
                const cur = lines[i];
                if (/^\s*\d+\.\s/.test(cur)) {
                    items.push(cur.replace(/^\s*\d+\.\s/, ''));
                    i++;
                    continue;
                }
                if (cur.trim() === '') {
                    // Look ahead past consecutive blanks for another numbered item.
                    let j = i + 1;
                    while (j < lines.length && lines[j].trim() === '') j++;
                    if (j < lines.length && /^\s*\d+\.\s/.test(lines[j])) {
                        i = j; // skip the blanks, continue the same list
                        continue;
                    }
                }
                break;
            }
            nodes.push(
                <ol key={k++} className="chat-md-ol">
                    {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
                </ol>
            );
            continue;
        }

        // Blockquote (> text)
        if (line.startsWith('> ')) {
            const bqLines: string[] = [];
            while (i < lines.length && lines[i].startsWith('> ')) {
                bqLines.push(lines[i].slice(2));
                i++;
            }
            nodes.push(
                <blockquote key={k++} className="chat-md-bq">
                    {bqLines.map((bLine, j) => <p key={j}>{inlineFormat(bLine)}</p>)}
                </blockquote>
            );
            continue;
        }

        // Horizontal rule
        if (/^[-_*]{3,}\s*$/.test(line) && line.trim() !== '') {
            nodes.push(<hr key={k++} className="chat-md-hr" />);
            i++;
            continue;
        }

        // Empty line — paragraph separator, skip
        if (line.trim() === '') {
            i++;
            continue;
        }

        // Default paragraph
        nodes.push(<p key={k++} className="chat-md-p">{inlineFormat(line)}</p>);
        i++;
    }

    return <div className="chat-markdown">{nodes}</div>;
}

/** Render inline markdown: bold, italic, inline code */
function inlineFormat(text: string): React.ReactNode {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
    return (
        <>
            {parts.map((part, i) => {
                if (!part) return null;
                if (part.startsWith('`') && part.endsWith('`') && part.length >= 3) {
                    return <code key={i} className="chat-inline-code">{part.slice(1, -1)}</code>;
                }
                if (part.startsWith('**') && part.endsWith('**') && part.length >= 5) {
                    return <strong key={i}>{part.slice(2, -2)}</strong>;
                }
                if (part.startsWith('*') && part.endsWith('*') && part.length >= 3) {
                    return <em key={i}>{part.slice(1, -1)}</em>;
                }
                return <React.Fragment key={i}>{part}</React.Fragment>;
            })}
        </>
    );
}

/** Render a markdown table */
function MdTable({ lines }: { lines: string[] }) {
    const parseRow = (row: string): string[] =>
        row.split('|').slice(1, -1).map((c) => c.trim());

    const isSeparator = (row: string) => /^\|[\s|:-]+\|$/.test(row.trim());

    const headerRow = lines[0] ? parseRow(lines[0]) : [];
    const dataLines = lines.filter((_, idx) => idx > 0 && !isSeparator(lines[idx]));

    return (
        <div className="chat-md-table-wrap">
            <table className="chat-md-table">
                {headerRow.length > 0 && (
                    <thead>
                        <tr>{headerRow.map((cell, i) => <th key={i}>{inlineFormat(cell)}</th>)}</tr>
                    </thead>
                )}
                <tbody>
                    {dataLines.map((row, ri) => (
                        <tr key={ri}>
                            {parseRow(row).map((cell, ci) => <td key={ci}>{inlineFormat(cell)}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
