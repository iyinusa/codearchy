import React, { useState, useRef, useEffect, useCallback } from 'react';
import { postMessage } from '../vscode';
import type { ChatMessage } from '../types';
import { Icon } from './Icons';

interface ChatPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function ChatPanel({ isOpen, onToggle }: ChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const recognitionRef = useRef<SpeechRecognition | null>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Listen for chat responses
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            switch (msg.type) {
                case 'chatChunk': {
                    const chunk = msg.payload as { content: string };
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
                    if (response.error) {
                        setError(response.error);
                        setIsStreaming(false);
                        return;
                    }
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === 'assistant' && last.isStreaming) {
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: response.content, isStreaming: false },
                            ];
                        }
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: response.content,
                                timestamp: Date.now(),
                                isStreaming: false,
                            },
                        ];
                    });
                    setIsStreaming(false);
                    break;
                }
                case 'error': {
                    const errPayload = msg.payload as { message: string };
                    setError(errPayload.message);
                    setIsStreaming(false);
                    break;
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

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
            setError(null);

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
    };

    // --- Audio: Voice Input ---
    const toggleRecording = useCallback(() => {
        if (isRecording) {
            recognitionRef.current?.stop();
            setIsRecording(false);
            return;
        }

        const SpeechRecognitionAPI =
            (window as unknown as Record<string, unknown>).SpeechRecognition ||
            (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

        if (!SpeechRecognitionAPI) {
            setError('Speech recognition is not supported in this environment.');
            return;
        }

        const recognition = new (SpeechRecognitionAPI as new () => SpeechRecognition)();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        recognition.onresult = (event: SpeechRecognitionEvent) => {
            const transcript = event.results[0]?.[0]?.transcript;
            if (transcript) {
                setInput((prev) => prev + transcript);
            }
            setIsRecording(false);
        };

        recognition.onerror = () => {
            setIsRecording(false);
        };

        recognition.onend = () => {
            setIsRecording(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
        setIsRecording(true);
    }, [isRecording]);

    // --- Audio: Text-to-Speech ---
    const speakText = useCallback(
        (text: string) => {
            if (isSpeaking) {
                window.speechSynthesis.cancel();
                setIsSpeaking(false);
                return;
            }

            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1;
            utterance.pitch = 1;
            utterance.onend = () => setIsSpeaking(false);
            utterance.onerror = () => setIsSpeaking(false);
            setIsSpeaking(true);
            window.speechSynthesis.speak(utterance);
        },
        [isSpeaking]
    );

    if (!isOpen) {
        return (
            <button className="chat-fab" onClick={onToggle} title="Open Architecture Chat">
                <Icon name="chatFab" size="lg" />
            </button>
        );
    }

    return (
        <div className="chat-panel">
            <div className="chat-header">
                <div className="chat-header-left">
                    <Icon name="systemView" className="chat-header-icon" />
                    <h3>Architecture Assistant</h3>
                </div>
                <div className="chat-header-actions">
                    <button className="chat-action-btn" onClick={clearChat} title="Clear conversation">
                        <Icon name="clearChat" />
                    </button>
                    <button className="chat-action-btn" onClick={onToggle} title="Minimize">
                        <Icon name="minimize" />
                    </button>
                </div>
            </div>

            <div className="chat-messages">
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
                    <div key={i} className={`chat-message chat-message-${msg.role}`}>
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
                            {msg.role === 'assistant' && !msg.isStreaming && (
                                <button
                                    className="chat-speak-btn"
                                    onClick={() => speakText(msg.content)}
                                    title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
                                >
                                    <Icon name={isSpeaking ? 'stopAction' : 'speakAloud'} />
                                </button>
                            )}
                        </div>
                    </div>
                ))}

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
                    <button
                        className={`chat-voice-btn ${isRecording ? 'recording' : ''}`}
                        onClick={toggleRecording}
                        title={isRecording ? 'Stop recording' : 'Voice input'}
                        disabled={isStreaming}
                    >
                        <Icon name={isRecording ? 'stopAction' : 'voiceInput'} />
                    </button>
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

/** Simple message formatter: handles markdown-like bold, code, and line breaks */
function formatMessage(text: string): React.ReactNode {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\n)/g);
    return parts.map((part, i) => {
        if (part === '\n') return <br key={i} />;
        if (part.startsWith('`') && part.endsWith('`')) {
            return <code key={i} className="chat-inline-code">{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
    });
}
