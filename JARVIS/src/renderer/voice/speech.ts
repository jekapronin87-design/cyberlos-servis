// Озвучка ответов: голоса Windows (без ключа) или облачный API.
import type { TtsMode } from '../../shared/types';

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let speakingListeners = new Set<(speaking: boolean) => void>();
let speaking = false;

const setSpeaking = (v: boolean): void => {
  speaking = v;
  speakingListeners.forEach((l) => l(v));
};

export const isSpeaking = (): boolean => speaking;
export const onSpeaking = (cb: (s: boolean) => void): (() => void) => {
  speakingListeners.add(cb);
  return () => speakingListeners.delete(cb);
};

export function cancelSpeech(): void {
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  setSpeaking(false);
}

function pickRussianVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ru'));
  // На Windows есть «Microsoft Irina/Pavel» — предпочитаем «естественные», затем любые русские.
  return voices.find((v) => /natural|online/i.test(v.name)) ?? voices[0];
}

export async function speak(text: string, mode: TtsMode): Promise<void> {
  cancelSpeech();
  if (mode === 'off' || !text.trim()) return;
  if (mode === 'system') {
    if (!window.speechSynthesis) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      const v = pickRussianVoice();
      if (v) u.voice = v;
      u.onend = u.onerror = () => {
        setSpeaking(false);
        resolve();
      };
      setSpeaking(true);
      window.speechSynthesis.speak(u);
    });
    return;
  }
  const { mime, data } = await window.jarvis.voice.speak(text);
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;
  setSpeaking(true);
  await new Promise<void>((resolve) => {
    audio.onended = audio.onerror = () => resolve();
    void audio.play().catch(() => resolve());
  });
  if (currentAudio === audio) cancelSpeech();
}
