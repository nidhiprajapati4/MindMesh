'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// The Web Speech API isn't in TypeScript's DOM types; only what is used here is described.
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionCtor = new () => Recognition;

const ctor = (): RecognitionCtor | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

/** What to tell the user for each way speech recognition can fail. */
const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.',
  'service-not-allowed': 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.',
  'no-speech': 'I didn’t hear anything. Tap the microphone and try again.',
  'audio-capture': 'No microphone was found. Connect one and try again.',
  network: 'Voice input needs an internet connection (your browser sends the audio to its speech service). Check your connection and try again.',
};

/**
 * Speech to text through the browser. `onText` gets the words so far (interim) and again with
 * `final: true` once the browser decides the sentence is finished. Nothing is sent to MindMesh.
 */
export function useSpeechInput(onText: (text: string, final: boolean) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    setSupported(!!ctor());
    return () => recRef.current?.abort();
  }, []);

  const start = useCallback(() => {
    const Ctor = ctor();
    if (!Ctor) return setError('Voice input isn’t supported in this browser. Try Chrome, Edge or Safari, or type your question.');
    setError('');
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    let heard = '';
    rec.onresult = (e) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      heard = text.trim();
      onTextRef.current(heard, final);
    };
    rec.onerror = (e) => {
      if (e.error !== 'aborted') setError(ERRORS[e.error] ?? 'Voice input stopped unexpectedly. Please try again.');
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setError('Voice input could not start. Please try again.');
    }
  }, []);

  const stop = useCallback(() => recRef.current?.stop(), []);

  return { supported, listening, error, clearError: () => setError(''), start, stop };
}
